/**
 * Process, session, and conversation orchestration for the Antigravity ACP
 * provider. One `agy acp` front serves every conversation; each DSH session
 * (and each auxiliary purpose within it) owns one ACP session whose history
 * advances incrementally, so subagents and the main conversation run
 * concurrently without sharing a turn.
 * @module dsh-llm-antigravity-acp/runtime
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { AcpProcess } from "./acp-process.js";
import { ModelCatalog, nearestEffort } from "./catalog.js";
import { asEffort, current } from "./config.js";
import { AcpTurn, AWAIT_TOOL, AWAIT_TOOL_NAME, CALL_TOOL, CALL_TOOL_NAME, pumpStep, relayNotice } from "./conversation.js";
import { AGENT_TOOL_PREFIX, bridgeSystemPrompt, inputPrompt, LOCKED_REPLAY_BUDGET_BYTES, MCP_SERVER_NAME, renderTranscript, replayPrompt, splitSystem, UNLOCKED_REPLAY_BUDGET_BYTES, } from "./history.js";
import { JsonRpcClosedError, JsonRpcRemoteError } from "./jsonrpc.js";
import { McpBridge } from "./mcp-bridge.js";
import { MetricsStore } from "./metrics.js";
import { assertSupportedAgyVersion, BRIDGE_AGENT, checkUnlock, defaultHome, defaultPatchScript, GPT_OSS_CONTEXT_WINDOW, LOCKED_CONTEXT_WINDOW, prepareHome, readVersion, resolveAgyBinary, syncOAuthToken, UNLOCKED_CONTEXT_WINDOW, } from "./preflight.js";
import { QuotaReader } from "./quota.js";
import { peekMaxModelStepIdx, readModelStepsAfter, sessionDbPath } from "./usage-db.js";
import { delay, digest, KeyedMutex } from "./util.js";
/** Parked calls answer with a still-running notice before Gemini cache TTL expiry and agy's 180-second MCP deadline. */
export const DEFAULT_RELAY_AFTER_MS = 85_000;
const CONTINUE_PROMPT = 'Continue exactly where your previous output stopped. Do not repeat any earlier text.';
const MAIN_PURPOSE = 'main';
/** Owner of the ACP process, the MCP bridge, and every conversation. */
export class AntigravityRuntime {
    host;
    bridge;
    catalog;
    quota;
    home;
    /** 本地遥测库；打不开就静默降级，绝不影响模型请求。 */
    metrics;
    process;
    starting;
    preflight;
    preflightPromise;
    state = 'idle';
    lastError;
    conversations = new Map();
    tenants = new Map();
    /** Per-turn call-id tags already issued or observed in history; keeps `<rootCallId>:ptc:<n>` unique session-wide. */
    usedTurnTags = new Set();
    mutex = new KeyedMutex();
    /** Serializes capacity checks and session creation so concurrent requests cannot overshoot maxLiveSessions. */
    capacityMutex = new KeyedMutex();
    sweeper;
    lastTurn;
    overrides = {};
    disposed = false;
    /** @param host - host services. */
    constructor(host) {
        this.host = host;
        this.home = host.config.home.length > 0 ? host.config.home : defaultHome();
        const telemetry = MetricsStore.open(join(this.home, 'metrics.db'));
        this.metrics = telemetry.store;
        if (telemetry.error !== undefined)
            host.log.warn(`antigravity-acp: metrics.db unavailable (${telemetry.error})`);
        this.catalog = new ModelCatalog(join(this.home, 'catalog.json'));
        this.bridge = new McpBridge({
            listTools: tenantKey => this.listTools(tenantKey),
            callTool: request => this.callTool(request),
            authorize: (tenantKey, bearerToken) => this.authorizeTenant(tenantKey, bearerToken),
        }, { keepAliveMs: host.config.keepAliveMs, log: message => host.log.info(message) });
        this.quota = new QuotaReader(() => this.preflight?.binary, host.runCommand, host.config.quotaTtlMs);
        this.sweeper = setInterval(() => this.sweep(), 60_000);
        this.sweeper.unref?.();
    }
    /** Configured context window (0 = auto). */
    configuredContextWindow() {
        return this.overrides.contextWindow ?? current(this.host.config.contextWindow);
    }
    /**
     * Declared context window of every family.
     * @returns tokens.
     */
    contextWindow() {
        const configured = this.configuredContextWindow();
        if (configured > 0)
            return configured;
        return this.preflight?.unlock.status === 'unlocked' ? UNLOCKED_CONTEXT_WINDOW : LOCKED_CONTEXT_WINDOW;
    }
    /**
     * Declared context window of one family. Claude 5.5 shares the 1M pool when
     * the binary is unlocked; GPT-OSS 120B keeps its own 128K-class window.
     * @param model - family id.
     * @returns tokens.
     */
    contextWindowFor(model) {
        const configured = this.configuredContextWindow();
        if (configured > 0)
            return configured;
        if (model.startsWith('gpt-oss'))
            return GPT_OSS_CONTEXT_WINDOW;
        return this.preflight?.unlock.status === 'unlocked' ? UNLOCKED_CONTEXT_WINDOW : LOCKED_CONTEXT_WINDOW;
    }
    /**
     * Effort one family will actually run at: the nearest offered effort, or the
     * one baked into a fixed-variant id such as `gpt-oss-120b-medium`.
     * @param model - family id.
     * @param requested - effort the caller asked for.
     * @returns the effort to apply.
     */
    effectiveEffort(model, requested) {
        const offered = this.catalog.effortsFor(model);
        if (offered.length > 0)
            return nearestEffort(requested, offered);
        return this.catalog.fixedEffort(model) ?? requested;
    }
    /** Default effort. */
    defaultEffort() {
        return this.overrides.defaultEffort ?? current(this.host.config.defaultEffort);
    }
    /** Maximum automatic long-decode continuations. */
    longDecodeContinuations() {
        return this.overrides.longDecodeContinuations ?? current(this.host.config.longDecodeContinuations);
    }
    /**
     * Apply live runtime settings immediately and notify catalog observers.
     * @param patch - updated fields.
     * @returns updated status.
     */
    configure(patch) {
        this.overrides = { ...this.overrides, ...patch };
        this.host.onModelsChanged();
        return this.status();
    }
    /**
     * Current status for diagnostics surfaces.
     * @returns the status snapshot.
     */
    status() {
        return {
            state: this.state,
            ...this.lastError !== undefined ? { error: this.lastError } : {},
            ...this.preflight !== undefined ? {
                binary: this.preflight.binary,
                version: this.preflight.version,
                home: this.preflight.home,
                unlock: this.preflight.unlock,
            } : {},
            contextWindow: this.contextWindow(),
            configuredContextWindow: this.configuredContextWindow(),
            defaultEffort: this.defaultEffort(),
            longDecodeContinuations: this.longDecodeContinuations(),
            models: this.catalog.list().map(m => ({ ...m })),
            efforts: [...this.catalog.effortList()],
            liveSessions: [...this.conversations.values()].filter(c => c.sessionId !== undefined).length,
            activeTurns: [...this.conversations.values()].filter(c => c.turn !== undefined && !c.turn.finished).length,
            ...this.lastTurn !== undefined ? { lastTurn: this.lastTurn } : {},
        };
    }
    /**
     * Run preflight and start the ACP process.
     * @returns the running process.
     */
    async ensureReady() {
        if (this.disposed)
            throw new LlmError('Antigravity provider was disposed', 'TRANSPORT');
        if (this.process?.alive === true)
            return this.process;
        this.starting ??= this.start().finally(() => { this.starting = undefined; });
        return this.starting;
    }
    /**
     * Warm the process and refresh the catalog through a tool-less discovery session.
     * @returns resolves when discovery finished.
     */
    async warmup() {
        const proc = await this.ensureReady();
        const result = await proc.newSession({
            cwd: this.preflight?.workspace ?? this.home,
            mcpServers: [],
        }, { onUpdate: () => undefined }, 120_000);
        if (this.catalog.observe(result.configOptions, result.models?.availableModels))
            this.host.onModelsChanged();
        await proc.closeSession(result.sessionId);
    }
    /** Stop every session, the process, and the bridge. */
    async dispose() {
        this.disposed = true;
        if (this.sweeper !== undefined)
            clearInterval(this.sweeper);
        for (const conv of this.conversations.values())
            conv.turn?.abandon('The harness provider was unloaded.');
        this.conversations.clear();
        this.tenants.clear();
        this.process?.stop();
        this.process = undefined;
        await this.bridge.close();
        this.metrics?.close();
        this.metrics?.dispose();
    }
    /**
     * Stream one DSH model step.
     * @param options - the model request.
     * @yields stream chunks.
     */
    async *stream(options) {
        if (options.signal?.aborted === true) {
            yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } } };
            return;
        }
        const proc = await this.ensureReady();
        // Purposes are declared by producer packages this plugin does not import.
        const declaredPurpose = options.purpose;
        const purpose = declaredPurpose !== undefined && declaredPurpose.length > 0 ? declaredPurpose : MAIN_PURPOSE;
        const scope = options.sessionId ?? `anon-${randomBytes(6).toString('hex')}`;
        const key = `${scope}|${purpose}`;
        const release = await this.mutex.acquire(key);
        let conv;
        try {
            conv = await this.acquireConversation(key, purpose);
            conv.lastUsed = Date.now();
            const split = splitSystem(options);
            const tools = toBridgeTools(options.tools);
            conv.toolNames = new Set(tools.map(t => t.name));
            const effort = this.effectiveEffort(options.model, asEffort(options.reasoningEffort) ?? this.defaultEffort());
            if (conv.turn !== undefined && conv.turn.pendingCalls.size > 0) {
                // Resuming a parked turn is only valid while the request still starts
                // with the exact history this ACP session already owns. A compaction
                // checkpoint or a pruned/rewritten prefix means the live server-side
                // context is stale: resolving the parked calls would grow it further
                // instead of adopting the compacted history, so abandon the turn and
                // let plan() rebuild the session from DSH's authoritative messages.
                if (!this.historyPrefixIntact(conv, split.system, split.messages)) {
                    this.dropTurn(conv, 'The conversation history was compacted or rewritten; rebuilding the session from the harness history.');
                }
                else {
                    const resumed = await this.deliverResults(conv, split.messages, proc, tools);
                    if (resumed) {
                        conv.knownIds = messageIds(split.messages);
                        // Same ACP session, same history prefix: the implicit cache is still warm.
                        yield* this.pump(conv, proc, options, effort, 'HIT');
                        return;
                    }
                    this.dropTurn(conv, 'The conversation history changed; the harness restarted this turn.');
                }
            }
            else if (conv.turn !== undefined) {
                this.dropTurn(conv, 'Superseded by a newer request.');
            }
            const plan = this.plan(conv, split.system, split.messages);
            const sessionCache = conv.sessionId !== undefined && !plan.rebuild ? 'HIT' : 'MISS';
            if (plan.rebuild)
                await this.resetSession(conv);
            if (conv.sessionId === undefined) {
                conv.systemHash = digest(split.system);
                await this.openSession(conv, split.system, tools, proc);
            }
            await this.select(conv, proc, options.model, effort);
            const replayBudget = this.preflight?.unlock.status === 'unlocked'
                ? UNLOCKED_REPLAY_BUDGET_BYTES
                : LOCKED_REPLAY_BUDGET_BYTES;
            let blocks;
            if (plan.rebuild) {
                blocks = await replayPrompt(plan.history, plan.input, this.host.readImage, replayBudget);
            }
            else {
                blocks = await inputPrompt(plan.input, this.host.readImage);
                const toolDelta = consumeToolDelta(conv, tools);
                if (toolDelta.length > 0)
                    blocks.unshift({ type: 'text', text: `${toolDelta}\n\n` });
            }
            conv.knownIds = messageIds(split.messages);
            // A new turn starts with an empty reported-identity space: ids from past
            // turns must never back a fresh permission request.
            conv.reportedToolCalls.clear();
            conv.turn = new AcpTurn(this.nextTurnTag(split.messages));
            if (conv.sessionId !== undefined) {
                conv.usageCursor = peekMaxModelStepIdx(sessionDbPath(this.home, conv.sessionId));
            }
            this.startPrompt(conv, proc, blocks);
            yield* this.pump(conv, proc, options, effort, sessionCache);
        }
        finally {
            release();
            if (conv !== undefined) {
                conv.opening = false;
                await this.afterStep(conv);
            }
        }
    }
    /**
     * Acquire one conversation under the capacity gate. When every slot is busy,
     * the oldest idle (non-opening) session is evicted first; if the cap is still
     * reached, the request is rejected immediately instead of queueing, because a
     * waiting subagent and its parent share the same provider route and would
     * deadlock.
     */
    async acquireConversation(key, purpose) {
        const existing = this.conversations.get(key);
        if (existing !== undefined) {
            existing.opening = true;
            return existing;
        }
        const unlock = await this.capacityMutex.acquire('capacity');
        try {
            const again = this.conversations.get(key);
            if (again !== undefined) {
                again.opening = true;
                return again;
            }
            const max = Math.max(1, this.host.config.maxLiveSessions);
            if (this.conversations.size >= max) {
                const idle = [...this.conversations.values()]
                    .filter(c => c.turn === undefined && !c.opening)
                    .sort((a, b) => a.lastUsed - b.lastUsed);
                while (this.conversations.size >= max && idle.length > 0) {
                    const victim = idle.shift();
                    this.conversations.delete(victim.key);
                    await this.resetSession(victim);
                }
            }
            if (this.conversations.size >= max) {
                throw new LlmError(`CAPACITY_EXCEEDED: maxLiveSessions (${max}) reached`, 'RATE_LIMIT');
            }
            const conv = this.createConversation(key, purpose);
            conv.opening = true;
            return conv;
        }
        finally {
            unlock();
        }
    }
    createConversation(key, purpose) {
        const conv = {
            key,
            purpose,
            tenantKey: undefined,
            tenantSecret: undefined,
            sessionId: undefined,
            process: undefined,
            configOptions: [],
            systemHash: undefined,
            advertisedTools: [],
            advertisedToolNames: new Set(),
            knownTools: new Map(),
            toolNames: new Set(),
            reportedToolCalls: new Map(),
            opening: false,
            usageCursor: -1,
            knownIds: undefined,
            issuedIds: new Set(),
            turn: undefined,
            dirty: false,
            lastUsed: Date.now(),
            model: undefined,
            effort: undefined,
        };
        this.conversations.set(key, conv);
        return conv;
    }
    async start() {
        this.state = 'starting';
        try {
            const preflight = await this.runPreflight();
            await this.bridge.start();
            const argv = [
                preflight.binary, 'acp',
                '--gemini-dir', preflight.home,
                '--app-data-dir', 'agy',
                '--agent', BRIDGE_AGENT,
                '--process-per-session',
                '--disable-telemetry',
                '--log-file', preflight.logFile,
            ];
            const proc = new AcpProcess({
                argv,
                cwd: preflight.workspace,
                spawn: this.host.spawnAcp,
                // The ACP server only advertises Claude and GPT-OSS to clients on its
                // JetBrains/Zed/Xcode allowlist; this prefix is what unlocks them.
                clientName: 'jetbrains.dsh',
                clientVersion: '0.1.0',
                log: message => this.host.log.warn(message),
            });
            proc.onExit(error => this.onProcessExit(proc, error));
            await proc.start(120_000);
            this.process = proc;
            this.state = 'ready';
            this.lastError = undefined;
            return proc;
        }
        catch (error) {
            this.state = 'error';
            this.lastError = error instanceof Error ? error.message : String(error);
            throw mapError(error);
        }
    }
    runPreflight() {
        if (this.preflight !== undefined)
            return Promise.resolve(this.preflight);
        this.preflightPromise ??= (async () => {
            const config = this.host.config;
            const binary = resolveAgyBinary(config.command);
            const version = await readVersion(binary, this.host.runCommand);
            assertSupportedAgyVersion(version, binary);
            const script = config.patchScript.length > 0 ? config.patchScript : defaultPatchScript();
            const unlock = await checkUnlock(binary, script, config.autoPatch, this.host.runCommand);
            this.host.log.info(`antigravity-acp: ${unlock.detail}`);
            const workspace = prepareHome(this.home);
            const result = { binary, version, home: this.home, workspace, logFile: join(this.home, 'acp.log'), unlock };
            this.preflight = result;
            this.host.onModelsChanged();
            return result;
        })().finally(() => { this.preflightPromise = undefined; });
        return this.preflightPromise;
    }
    onProcessExit(proc, error) {
        if (this.process === proc)
            this.process = undefined;
        if (!this.disposed) {
            this.state = 'error';
            this.lastError = error.message;
            this.host.log.warn(`antigravity-acp: ${error.message}`);
        }
        for (const conv of this.conversations.values()) {
            if (conv.process !== proc)
                continue;
            conv.turn?.events.push({ kind: 'error', error: new LlmError(`Antigravity ACP process exited: ${error.message}`, 'TRANSPORT') });
            this.releaseTenant(conv);
            conv.sessionId = undefined;
            conv.process = undefined;
            conv.tenantKey = undefined;
            conv.tenantSecret = undefined;
            conv.advertisedTools = [];
            conv.advertisedToolNames.clear();
            conv.knownTools.clear();
            conv.reportedToolCalls.clear();
            conv.usageCursor = -1;
            conv.dirty = true;
        }
    }
    async openSession(conv, system, tools, proc) {
        syncOAuthToken(this.home);
        conv.reportedToolCalls.clear();
        conv.advertisedTools = [...tools];
        conv.advertisedToolNames = new Set(tools.map(t => t.name));
        conv.knownTools = new Map(tools.map(t => [t.name, digest(t)]));
        const attachMcp = conv.advertisedTools.length > 0 || conv.purpose === MAIN_PURPOSE;
        const tenantKey = attachMcp ? randomBytes(16).toString('hex') : undefined;
        const tenantSecret = tenantKey !== undefined ? randomBytes(24).toString('hex') : undefined;
        const mcpServers = tenantKey !== undefined && tenantSecret !== undefined
            ? [{ type: 'http', name: MCP_SERVER_NAME, url: `${this.bridge.url}/${tenantKey}`, headers: [{ name: 'Authorization', value: `Bearer ${tenantSecret}` }] }]
            : [];
        conv.tenantKey = tenantKey;
        conv.tenantSecret = tenantSecret;
        if (tenantKey !== undefined)
            this.tenants.set(tenantKey, conv);
        try {
            const result = await proc.newSession({
                cwd: this.preflight?.workspace ?? this.home,
                mcpServers,
                _meta: { antigravity: { systemPrompt: { append: bridgeSystemPrompt(system) } } },
            }, {
                onUpdate: (update) => {
                    if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
                        conv.configOptions = update.configOptions;
                        if (this.catalog.observe(update.configOptions))
                            this.host.onModelsChanged();
                    }
                    if (recordReportedToolCall(conv, update) === 'conflict') {
                        this.host.log.warn(`antigravity-acp: agent reported conflicting identity for tool call ${String(update.toolCallId)}`);
                    }
                    conv.turn?.onUpdate(update);
                },
                onPermission: request => this.answerPermission(conv, request),
            }, 120_000);
            conv.sessionId = result.sessionId;
            conv.process = proc;
            conv.configOptions = result.configOptions ?? [];
            conv.model = undefined;
            conv.effort = undefined;
            conv.usageCursor = -1;
            conv.dirty = false;
            conv.issuedIds.clear();
            if (this.catalog.observe(result.configOptions, result.models?.availableModels))
                this.host.onModelsChanged();
        }
        catch (error) {
            this.releaseTenant(conv);
            conv.tenantKey = undefined;
            conv.tenantSecret = undefined;
            conv.advertisedTools = [];
            conv.advertisedToolNames.clear();
            conv.knownTools.clear();
            throw mapError(error);
        }
    }
    /** Constant-time check of one tenant's current bearer credential. */
    authorizeTenant(tenantKey, bearerToken) {
        if (tenantKey === undefined || bearerToken === undefined)
            return false;
        const secret = this.tenants.get(tenantKey)?.tenantSecret;
        if (secret === undefined)
            return false;
        const left = Buffer.from(bearerToken, 'utf8');
        const right = Buffer.from(secret, 'utf8');
        if (left.length !== right.length) {
            timingSafeEqual(left, left);
            return false;
        }
        return timingSafeEqual(left, right);
    }
    /** Drop one conversation's tenant registration together with its bridge handshake evidence. */
    releaseTenant(conv) {
        if (conv.tenantKey === undefined)
            return;
        this.tenants.delete(conv.tenantKey);
        this.bridge.forgetTenant(conv.tenantKey);
    }
    /**
     * Decide one `session/request_permission` from structured host-reported
     * metadata only. `title` and `rawInput` are never matched against tool
     * names: a native tool whose payload merely contains `mcp_dsh_…` or a
     * spoofed title must not unlock the bridge.
     */
    answerPermission(conv, request) {
        const pick = (kind) => {
            const option = request.options.find(o => o.kind === kind);
            return option === undefined ? undefined : { outcome: 'selected', optionId: option.optionId };
        };
        const reject = (reason) => {
            this.host.log.warn(`antigravity-acp: refused permission request (${reason}): ${request.toolCall?.title ?? 'unknown'}`);
            return pick('reject_once') ?? { outcome: 'cancelled' };
        };
        if (conv.sessionId === undefined || request.sessionId !== conv.sessionId)
            return reject('session mismatch');
        if (conv.tenantKey === undefined)
            return reject('no MCP bridge is mounted for this session');
        if (conv.turn === undefined || conv.turn.finished)
            return reject('no live turn');
        const toolCallId = request.toolCall?.toolCallId;
        if (typeof toolCallId !== 'string' || toolCallId.length === 0)
            return reject('missing toolCallId');
        const reported = conv.reportedToolCalls.get(toolCallId);
        const claimed = structuredToolMeta(request.toolCall);
        if (reported === undefined) {
            // Nothing the agent reported in `session/update` backs this call: its own
            // in-request metadata is untrusted (stale or cross-session toolCallId).
            if (claimed.serverName !== undefined || claimed.toolName !== undefined) {
                return reject(`tool call ${toolCallId} was never reported by the agent`);
            }
            // The only identity-less exception is the agent's MCP loading probe
            // (no tool name, no input), and it must be bound to explicit evidence:
            // this tenant itself completed the MCP handshake with its bearer secret.
            // Even then the probe is never granted `allow_always`.
            if (request.toolCall?.kind === 'other' && isEmptyInput(request.toolCall.rawInput)) {
                if (!this.bridge.hasHandshake(conv.tenantKey)) {
                    return reject('identity-less probe without a completed MCP handshake');
                }
                return pick('allow_once') ?? { outcome: 'cancelled' };
            }
            return reject('missing structured tool metadata');
        }
        if (reported.conflict === true) {
            return reject(`reported identity of tool call ${toolCallId} conflicts across agent updates`);
        }
        if (claimed.serverName !== undefined && claimed.serverName !== reported.serverName)
            return reject('MCP server name conflict');
        if (claimed.toolName !== undefined && claimed.toolName !== reported.toolName)
            return reject('tool name conflict');
        if (reported.serverName !== MCP_SERVER_NAME)
            return reject(`unknown MCP server ${reported.serverName ?? '(none)'}`);
        const allowedTools = new Set([...conv.advertisedToolNames, AWAIT_TOOL_NAME, CALL_TOOL_NAME]);
        if (reported.toolName === undefined || !allowedTools.has(reported.toolName)) {
            return reject(`tool is not offered to this session: ${reported.toolName ?? '(none)'}`);
        }
        return pick('allow_once') ?? { outcome: 'cancelled' };
    }
    async select(conv, proc, model, effort) {
        const sessionId = conv.sessionId;
        const modelOption = conv.configOptions.find(o => o.id === 'model' || o.category === 'model');
        if (modelOption?.options !== undefined && !modelOption.options.some(o => o.value === model)) {
            throw new LlmError(`Antigravity does not offer model "${model}" to this account; available: ${modelOption.options.map(o => o.value).join(', ')}`, 'UNKNOWN_MODEL');
        }
        if (conv.model !== model && modelOption?.currentValue !== model) {
            conv.configOptions = await proc.setConfigOption(sessionId, modelOption?.id ?? 'model', model).catch((error) => { throw mapError(error); });
        }
        conv.model = model;
        const levelOption = conv.configOptions.find(o => o.id === 'thought_level' || o.category === 'thought_level');
        // Fixed-variant families (GPT-OSS) reject every thought_level change; the
        // effort already lives in the model id, so only selectable families write it.
        const selectable = this.catalog.effortsFor(model);
        if (selectable.length > 0 && levelOption !== undefined && conv.effort !== effort && levelOption.currentValue !== effort) {
            conv.configOptions = await proc.setConfigOption(sessionId, levelOption.id, effort).catch((error) => { throw mapError(error); });
        }
        conv.effort = effort;
    }
    plan(conv, system, messages) {
        const reusable = conv.sessionId !== undefined
            && !conv.dirty
            && conv.purpose === MAIN_PURPOSE
            && this.historyPrefixIntact(conv, system, messages);
        if (reusable) {
            const known = conv.knownIds;
            let rest = messages.slice(known.length);
            let skip = 0;
            while (skip < rest.length && this.isOwn(conv, rest[skip]))
                skip++;
            rest = rest.slice(skip);
            if (rest.length > 0 && rest.every(m => m.role === 'user' || m.role === 'developer' || m.role === 'system')) {
                return { rebuild: false, history: [], input: rest };
            }
        }
        let cut = messages.length;
        while (cut > 0) {
            const role = messages[cut - 1]?.role;
            if (role !== 'user' && role !== 'developer' && role !== 'system')
                break;
            cut--;
        }
        return { rebuild: true, history: messages.slice(0, cut), input: messages.slice(cut) };
    }
    /**
     * Whether the live ACP session's context is still an exact prefix of the
     * request: the same system prompt and the same message ids in the same order.
     * A compaction checkpoint, a pruned/rewritten prefix, or a replaced system
     * prompt all make the session stale and force a rebuild.
     * @param conv - conversation owning the ACP session.
     * @param system - current DSH system prompt.
     * @param messages - full request history after leading system messages.
     * @returns true when only new messages were appended.
     */
    historyPrefixIntact(conv, system, messages) {
        // plan() has always required the same system digest for reuse; a changed
        // digest is a genuinely new prompt, while mid-conversation updates travel
        // as `system` messages inside `messages` (systemPromptUpdate: 'in-history').
        if (conv.knownIds === undefined || conv.systemHash !== digest(system))
            return false;
        const known = conv.knownIds;
        return known.length <= messages.length
            && known.every((id, index) => messages[index]?.id === id);
    }
    isOwn(conv, message) {
        if (message.role === 'assistant')
            return message.source.kind === 'model' && message.source.provider === this.host.config.provider;
        if (message.role === 'tool')
            return conv.issuedIds.has(message.toolCallId);
        return false;
    }
    async resetSession(conv) {
        if (conv.sessionId !== undefined && conv.process !== undefined) {
            void conv.process.closeSession(conv.sessionId);
        }
        this.releaseTenant(conv);
        conv.sessionId = undefined;
        conv.tenantKey = undefined;
        conv.tenantSecret = undefined;
        conv.process = undefined;
        conv.advertisedTools = [];
        conv.advertisedToolNames.clear();
        conv.knownTools.clear();
        conv.reportedToolCalls.clear();
        conv.usageCursor = -1;
        conv.knownIds = undefined;
        conv.dirty = false;
    }
    startPrompt(conv, proc, blocks) {
        const turn = conv.turn;
        proc.prompt(conv.sessionId, blocks).then(result => turn.events.push({ kind: 'done', result }), (error) => turn.events.push({ kind: 'error', error: mapError(error) }));
    }
    async *pump(conv, proc, options, effort, sessionCache) {
        const turn = conv.turn;
        const sessionId = conv.sessionId;
        let finishKind;
        const requestId = randomUUID();
        const startedAt = Date.now();
        let ttftMs = 0;
        let usage;
        let toolCalls = 0;
        let failureMessage;
        const record = (status, errorMessage) => {
            const inputTokens = usage?.inputTokens ?? 0;
            const cachedReadTokens = usage?.cacheReadTokens ?? 0;
            const cachedWriteTokens = usage?.cacheWriteTokens ?? 0;
            const outputTokens = usage?.outputTokens ?? 0;
            const thoughtTokens = usage?.reasoningTokens ?? 0;
            this.metrics?.record({
                requestId,
                timestamp: startedAt,
                sessionId,
                workerId: 'agy-acp',
                sessionCache,
                requestedModel: options.model,
                resolvedBaseModel: options.model,
                thinkingLevel: effort,
                acpModelId: options.model,
                actualModelVersion: this.preflight?.version ?? 'unknown',
                ttftMs,
                durationMs: Date.now() - startedAt,
                stream: true,
                finishReason: finishKind ?? (status === 'error' ? 'error' : 'unknown'),
                toolCallsCount: toolCalls,
                inputTokens,
                cachedReadTokens,
                cachedWriteTokens,
                outputTokens,
                thoughtTokens,
                totalTokens: usage?.totalTokens ?? inputTokens + cachedReadTokens + cachedWriteTokens + outputTokens,
                status,
                ...errorMessage !== undefined ? { errorMessage } : {},
            });
        };
        try {
            for await (const chunk of pumpStep(turn, {
                parkSettleMs: this.host.config.parkSettleMs,
                maxContinuations: this.longDecodeContinuations(),
                continuePrompt: () => proc.prompt(sessionId, [{ type: 'text', text: CONTINUE_PROMPT }]),
                cancel: () => proc.cancel(sessionId),
                recordUsage: (usage, steps) => {
                    this.lastTurn = { model: options.model, effort, steps, ...usage !== undefined ? { usage } : {}, at: new Date().toISOString() };
                },
                consumeStepUsage: async () => {
                    const dbPath = sessionDbPath(this.home, sessionId);
                    if (!existsSync(dbPath))
                        return undefined;
                    let batch = readModelStepsAfter(dbPath, conv.usageCursor);
                    for (let attempt = 0; batch === undefined && attempt < 3; attempt++) {
                        await delay(25);
                        batch = readModelStepsAfter(dbPath, conv.usageCursor);
                    }
                    if (batch === undefined)
                        return undefined;
                    conv.usageCursor = batch.maxIdx;
                    turn.recordStepBatch(batch);
                    return { usage: batch.usage, calls: batch.calls };
                },
            }, options.signal)) {
                if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
                    conv.issuedIds.add(chunk.block.id);
                    toolCalls += 1;
                }
                if (chunk.type === 'usage')
                    usage = chunk.usage;
                if (chunk.type === 'finish') {
                    finishKind = chunk.reason.kind;
                    const reason = chunk.reason;
                    if (reason.failure?.message !== undefined)
                        failureMessage = reason.failure.message;
                }
                // 首字延迟按第一段模型输出算（思考流也算），tool-call-delta 是纯本地解析，不算
                if (ttftMs === 0 && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'))
                    ttftMs = Date.now() - startedAt;
                yield chunk;
            }
        }
        catch (error) {
            record('error', error instanceof Error ? error.message : String(error));
            conv.reportedToolCalls.clear();
            conv.turn = undefined;
            conv.dirty = true;
            throw mapError(error);
        }
        if (finishKind === 'tool-calls') {
            record('success');
            return;
        }
        if (finishKind === 'aborted')
            record('error', failureMessage ?? 'aborted by the harness');
        else if (finishKind === 'error')
            record('error', failureMessage ?? 'provider error');
        else
            record('success');
        if (finishKind === 'aborted') {
            // A cancelled turn leaves partial agent-side history; rebuild from DSH history next time.
            await Promise.race([turnSettled(turn), delay(5_000)]);
            conv.dirty = true;
        }
        // The turn is over: clear the identities it established with it.
        conv.reportedToolCalls.clear();
        conv.turn = undefined;
    }
    async deliverResults(conv, messages, proc, tools) {
        const turn = conv.turn;
        const results = new Map();
        let last = -1;
        messages.forEach((message, index) => {
            if (message.role === 'tool' && turn.pendingCalls.has(message.toolCallId)) {
                results.set(message.toolCallId, message);
                last = Math.max(last, index);
            }
        });
        if (results.size !== turn.pendingCalls.size)
            return false;
        const extras = messages.slice(last + 1);
        if (extras.some(m => m.role === 'assistant' || m.role === 'tool'))
            return false;
        const extraText = extras.length > 0 ? renderTranscript(extras) : '';
        const toolDelta = consumeToolDelta(conv, tools);
        const suffix = [toolDelta, extraText].filter(Boolean).join('\n\n');
        const pending = [...turn.pendingCalls.values()];
        turn.pendingCalls.clear();
        if (turn.finished || !this.isTurnLive(turn)) {
            // The agent ended its turn while the harness ran the tools: hand the results over as new input.
            const transcript = renderTranscript(pending.map(call => results.get(call.id)));
            // The old turn is over: its reported identities do not carry into the continuation.
            conv.reportedToolCalls.clear();
            conv.turn = new AcpTurn(this.nextTurnTag(messages));
            if (conv.sessionId !== undefined) {
                conv.usageCursor = peekMaxModelStepIdx(sessionDbPath(this.home, conv.sessionId));
            }
            this.startPrompt(conv, proc, [{ type: 'text', text: `${transcript}${suffix ? `\n\n${suffix}` : ''}\n\nContinue the task with these tool results.` }]);
            return true;
        }
        for (const [index, call] of pending.entries()) {
            const message = results.get(call.id);
            const result = await this.toBridgeResult(message.content, message.isError === true);
            if (index === pending.length - 1 && suffix.length > 0)
                result.content.push({ type: 'text', text: `\n\n${suffix}` });
            call.result.resolve(result);
        }
        return true;
    }
    isTurnLive(turn) {
        const head = turn.events.peek();
        return head?.kind !== 'done' && head?.kind !== 'error';
    }
    async toBridgeResult(content, isError) {
        const items = [];
        for (const block of content) {
            if (block.type === 'text') {
                if (block.text.length > 0)
                    items.push({ type: 'text', text: block.text });
            }
            else if (block.type === 'image' && block.offloaded !== true && this.host.canReadImages()) {
                const image = await this.host.readImage(block);
                if (image !== undefined)
                    items.push({ type: 'image', data: image.data, mimeType: image.mimeType });
                else
                    items.push({ type: 'text', text: `[image ${block.attachment.attachmentId} unavailable]` });
            }
            else {
                const rendered = renderTranscript([{ role: 'user', content: [block] }]);
                if (rendered.length > 0)
                    items.push({ type: 'text', text: rendered });
            }
        }
        if (items.length === 0)
            items.push({ type: 'text', text: '(no output)' });
        return { content: items, ...isError ? { isError: true } : {} };
    }
    dropTurn(conv, reason) {
        const turn = conv.turn;
        if (turn === undefined)
            return;
        if (!turn.finished && conv.sessionId !== undefined)
            conv.process?.cancel(conv.sessionId);
        turn.abandon(reason);
        conv.turn = undefined;
        conv.dirty = true;
        conv.reportedToolCalls.clear();
    }
    /** A conversation is idle only when no turn is running and no session is opening. */
    isIdle(conv) {
        return conv.turn === undefined && !conv.opening;
    }
    async afterStep(conv) {
        conv.lastUsed = Date.now();
        const idle = this.isIdle(conv);
        if (idle && (conv.purpose !== MAIN_PURPOSE || conv.key.startsWith('anon-'))) {
            await this.resetSession(conv);
            this.conversations.delete(conv.key);
            return;
        }
        // A failed opening leaves an unusable empty shell: release its capacity slot.
        if (idle && conv.sessionId === undefined && this.conversations.get(conv.key) === conv) {
            this.conversations.delete(conv.key);
        }
    }
    listTools(tenantKey) {
        const conv = tenantKey === undefined ? undefined : this.tenants.get(tenantKey);
        if (conv === undefined)
            return [];
        return [...conv.advertisedTools, AWAIT_TOOL, CALL_TOOL];
    }
    async callTool(request) {
        // Only the tenant mounted for this exact conversation may drive its tools;
        // a bare `conversationId` never grants routing on its own.
        const conv = request.tenantKey !== undefined ? this.tenants.get(request.tenantKey) : undefined;
        if (conv === undefined) {
            return { content: [{ type: 'text', text: 'No harness turn is waiting for this tool call.' }], isError: true };
        }
        if (request.conversationId !== undefined && (conv.sessionId === undefined || request.conversationId !== conv.sessionId)) {
            return { content: [{ type: 'text', text: 'Tenant session mismatch.' }], isError: true };
        }
        const turn = conv.turn;
        if (turn === undefined || turn.finished) {
            return { content: [{ type: 'text', text: 'No harness turn is waiting for this tool call.' }], isError: true };
        }
        if (request.name === AWAIT_TOOL_NAME) {
            const callId = typeof request.arguments.call_id === 'string' ? request.arguments.call_id : '';
            const call = turn.calls.get(callId);
            if (call === undefined)
                return { content: [{ type: 'text', text: `Unknown harness call id ${callId}.` }], isError: true };
            turn.relaying = false;
            return this.awaitCall(turn, call, request.signal);
        }
        if (request.name === CALL_TOOL_NAME) {
            const rawTarget = typeof request.arguments.name === 'string' ? request.arguments.name.trim() : '';
            const targetName = rawTarget.startsWith(AGENT_TOOL_PREFIX) ? rawTarget.slice(AGENT_TOOL_PREFIX.length) : rawTarget;
            const rawArgs = request.arguments.arguments;
            const targetArgs = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
                ? rawArgs
                : {};
            if (!conv.toolNames.has(targetName)) {
                return { content: [{ type: 'text', text: `The harness has no tool named ${targetName}.` }], isError: true };
            }
            const call = turn.park(targetName, targetArgs);
            return this.awaitCall(turn, call, request.signal);
        }
        if (!conv.toolNames.has(request.name)) {
            return { content: [{ type: 'text', text: `The harness has no tool named ${request.name}.` }], isError: true };
        }
        const call = turn.park(request.name, request.arguments);
        return this.awaitCall(turn, call, request.signal);
    }
    async awaitCall(turn, call, signal) {
        let timer;
        const relayAfterMs = this.host.relayAfterMs ?? this.host.config.relayAfterMs ?? DEFAULT_RELAY_AFTER_MS;
        const relay = new Promise(resolve => { timer = setTimeout(() => resolve('relay'), relayAfterMs); });
        const aborted = new Promise(resolve => {
            if (signal.aborted)
                resolve('aborted');
            else
                signal.addEventListener('abort', () => resolve('aborted'), { once: true });
        });
        try {
            const outcome = await Promise.race([call.result.promise, relay, aborted]);
            if (outcome === 'relay') {
                turn.relaying = true;
                return relayNotice(call);
            }
            if (outcome === 'aborted')
                return { content: [{ type: 'text', text: 'The tool call was cancelled.' }], isError: true };
            return outcome;
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
    sweep() {
        const ttl = this.host.config.idleSessionTtlMs;
        const now = Date.now();
        for (const conv of [...this.conversations.values()]) {
            if (this.isIdle(conv) && now - conv.lastUsed > ttl) {
                void this.resetSession(conv);
                this.conversations.delete(conv.key);
            }
        }
    }
    /**
     * Mint a fresh 48-bit hex turn tag (`agy_<tag>_<n>`) disjoint from every
     * call id already issued by this runtime or present in `messages`, so
     * multi-turn tool calls and derived `<rootCallId>:ptc:<n>` sub-call ids
     * never collide within a durable session.
     */
    nextTurnTag(messages) {
        collectUsedTurnTags(messages, this.usedTurnTags);
        for (;;) {
            const candidate = randomBytes(6).toString('hex');
            if (!this.usedTurnTags.has(candidate)) {
                this.usedTurnTags.add(candidate);
                return candidate;
            }
        }
    }
}
function collectUsedTurnTags(messages, into) {
    const recordId = (id) => {
        if (typeof id !== 'string')
            return;
        const match = /^agy_([0-9a-f]+)_/i.exec(id);
        if (match?.[1] !== undefined)
            into.add(match[1].toLowerCase());
    };
    for (const message of messages) {
        if (message.role === 'tool') {
            recordId(message.toolCallId);
        }
        else if (message.role === 'assistant') {
            for (const block of message.content) {
                if (block.type === 'tool-call')
                    recordId(block.id);
            }
        }
    }
}
function messageIds(messages) {
    return messages.map(m => m.id ?? '');
}
/** Read a non-empty string field. */
function nonEmpty(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/**
 * Extract the structured `(serverName, toolName)` an agent claimed in one
 * permission request: top-level `mcpServerName`/`mcpToolName` or `_meta`.
 * `title` and `rawInput` are deliberately not consulted.
 */
function structuredToolMeta(toolCall) {
    const meta = toolCall?._meta;
    const serverName = nonEmpty(toolCall?.mcpServerName) ?? nonEmpty(meta?.mcpServerName) ?? nonEmpty(meta?.serverName) ?? nonEmpty(meta?.server);
    const toolName = nonEmpty(toolCall?.mcpToolName) ?? nonEmpty(meta?.mcpToolName) ?? nonEmpty(meta?.toolName) ?? nonEmpty(meta?.tool);
    return {
        ...(serverName !== undefined ? { serverName } : {}),
        ...(toolName !== undefined ? { toolName } : {}),
    };
}
/**
 * Record the structured metadata of one agent-reported tool-call update.
 * The first report establishes the identity; later updates merge only the
 * fields actually present, so a status-only `tool_call_update` never wipes an
 * established `server`/`tool`/`kind`. A later field that contradicts the
 * established identity keeps the original value and marks the record
 * anomalous — the permission gate refuses every further request for that call.
 * @returns 'created' | 'merged' | 'conflict', or undefined for ignored updates.
 */
function recordReportedToolCall(conv, update) {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')
        return;
    if (typeof update.toolCallId !== 'string' || update.toolCallId.length === 0)
        return;
    const meta = update._meta;
    const serverName = nonEmpty(update.mcpServerName) ?? nonEmpty(meta?.mcpServerName) ?? nonEmpty(meta?.serverName) ?? nonEmpty(meta?.server);
    const toolName = nonEmpty(update.mcpToolName) ?? nonEmpty(meta?.mcpToolName) ?? nonEmpty(meta?.toolName) ?? nonEmpty(meta?.tool);
    const kind = typeof update.kind === 'string' ? update.kind : undefined;
    const existing = conv.reportedToolCalls.get(update.toolCallId);
    const merged = existing === undefined ? {} : { ...existing };
    let conflict = false;
    if (kind !== undefined) {
        if (merged.kind !== undefined && merged.kind !== kind)
            conflict = true;
        else
            merged.kind = kind;
    }
    if (serverName !== undefined) {
        if (merged.serverName !== undefined && merged.serverName !== serverName)
            conflict = true;
        else
            merged.serverName = serverName;
    }
    if (toolName !== undefined) {
        if (merged.toolName !== undefined && merged.toolName !== toolName)
            conflict = true;
        else
            merged.toolName = toolName;
    }
    if (conflict)
        merged.conflict = true;
    conv.reportedToolCalls.set(update.toolCallId, merged);
    if (conflict)
        return 'conflict';
    return existing === undefined ? 'created' : 'merged';
}
/** Whether `rawInput` carries no arguments at all (MCP server loading probes). */
function isEmptyInput(rawInput) {
    if (rawInput === undefined || rawInput === null)
        return true;
    if (typeof rawInput === 'string')
        return rawInput.trim().length === 0;
    if (Array.isArray(rawInput))
        return rawInput.length === 0;
    if (typeof rawInput === 'object')
        return Object.keys(rawInput).length === 0;
    return false;
}
/**
 * Diff active tools against the session's known tool set and render a compact
 * `<harness_tool_update>` block for newly added, modified, restored, or disabled tools.
 * @param conv - conversation tool state (`advertisedToolNames` and `knownTools`).
 * @param tools - active tools for the current step.
 * @returns `<harness_tool_update>` text block, or `''` when unchanged.
 */
export function consumeToolDelta(conv, tools) {
    const lines = [];
    const active = new Set();
    for (const tool of tools) {
        active.add(tool.name);
        const hash = digest(tool);
        if (conv.knownTools.get(tool.name) === hash)
            continue;
        conv.knownTools.set(tool.name, hash);
        if (conv.advertisedToolNames.has(tool.name)) {
            lines.push(`[tool restored: ${AGENT_TOOL_PREFIX}${tool.name}]`);
        }
        else {
            lines.push(`[tool available via ${AGENT_TOOL_PREFIX}${CALL_TOOL_NAME} with {"name":"${tool.name}","arguments":{...}}]: ${JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.inputSchema })}`);
        }
    }
    for (const name of [...conv.knownTools.keys()]) {
        if (!active.has(name)) {
            conv.knownTools.delete(name);
            lines.push(`[tool disabled: ${name}]`);
        }
    }
    return lines.length > 0 ? `<harness_tool_update>\n${lines.join('\n')}\n</harness_tool_update>` : '';
}
/** Byte ceiling keeping advertised MCP tool schemas below agy's ~1,500B lazy cutoff. */
export const MAX_EAGER_BRIDGE_TOOL_BYTES = 1_350;
function shortenText(text, maxChars) {
    const clean = text.replace(/\s+/gu, ' ').trim();
    if (clean.length <= maxChars)
        return clean;
    const sentenceEnd = clean.indexOf('. ');
    if (sentenceEnd >= 32 && sentenceEnd + 1 <= maxChars)
        return clean.slice(0, sentenceEnd + 1);
    return `${clean.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}
function compactSchemaNode(value, maxDescChars) {
    if (Array.isArray(value))
        return value.map(item => compactSchemaNode(item, maxDescChars));
    if (value === null || typeof value !== 'object')
        return value;
    const record = value;
    const out = {};
    for (const [key, entry] of Object.entries(record)) {
        if (key === 'description' && typeof entry === 'string') {
            if (maxDescChars > 0)
                out[key] = shortenText(entry, maxDescChars);
            continue;
        }
        if (key === 'properties' && entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
            const props = {};
            for (const [propKey, propVal] of Object.entries(entry)) {
                props[propKey] = compactSchemaNode(propVal, maxDescChars);
            }
            out[key] = props;
            continue;
        }
        out[key] = compactSchemaNode(entry, maxDescChars);
    }
    return out;
}
/**
 * Keep each MCP-advertised tool schema under `agy`'s eager size threshold while
 * preserving every parameter name, type, required list, and enum constraint.
 * Full prose instructions remain in DSH's system prompt.
 * @param tool - raw bridge tool descriptor.
 * @returns compacted descriptor when oversized, otherwise the original descriptor.
 */
export function compactBridgeTool(tool) {
    if (Buffer.byteLength(JSON.stringify(tool), 'utf8') <= MAX_EAGER_BRIDGE_TOOL_BYTES)
        return tool;
    const pass1 = {
        name: tool.name,
        description: shortenText(tool.description, 220),
        inputSchema: compactSchemaNode(tool.inputSchema, 90),
    };
    if (Buffer.byteLength(JSON.stringify(pass1), 'utf8') <= MAX_EAGER_BRIDGE_TOOL_BYTES)
        return pass1;
    return {
        name: tool.name,
        description: shortenText(tool.description, 140),
        inputSchema: compactSchemaNode(tool.inputSchema, 0),
    };
}
function toBridgeTools(tools) {
    return (tools ?? []).filter(t => t.deferLoading !== true).map(t => compactBridgeTool({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters.type === undefined ? { type: 'object', ...t.parameters } : t.parameters,
    }));
}
function turnSettled(turn) {
    return (async () => {
        while (turn.events.size > 0 || !turn.finished) {
            const head = turn.events.peek();
            if (head?.kind === 'done' || head?.kind === 'error')
                return;
            await delay(100);
        }
    })();
}
/**
 * Map transport and agent failures onto stable DSH failure codes.
 * @param error - the failure.
 * @returns an LlmError.
 */
export function mapError(error) {
    if (error instanceof LlmError)
        return error;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof JsonRpcClosedError)
        return new LlmError(`Antigravity ACP link closed: ${message}`, 'TRANSPORT', { cause: error });
    if (/authentication required|not logged in|unauthenticated|sign in/i.test(message)) {
        return new LlmError(`Antigravity requires sign-in: run \`agy\` once in a terminal (${message})`, 'AUTH', { cause: error });
    }
    if (/quota|resource.?exhausted|limit reached|exceeded your/i.test(message))
        return new LlmError(message, 'QUOTA', { cause: error });
    if (/rate.?limit|429|too many requests|overloaded|capacity/i.test(message))
        return new LlmError(message, 'RATE_LIMIT', { cause: error });
    if (/context|too long|token limit|maximum.*tokens/i.test(message))
        return new LlmError(message, 'CONTEXT_WINDOW_EXCEEDED', { cause: error });
    if (/timeout|timed out|deadline/i.test(message))
        return new LlmError(message, 'TIMEOUT', { cause: error });
    if (error instanceof JsonRpcRemoteError)
        return new LlmError(`Antigravity: ${message}`, 'SERVER', { cause: error });
    return new LlmError(message, 'TRANSPORT', { cause: error });
}
