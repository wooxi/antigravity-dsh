/**
 * Local telemetry store for the Antigravity provider.
 *
 * Schema is copied verbatim from `agy-acp2api/src/telemetry/metrics-store.ts`
 * (`sessions` + `requests`) so the dashboard can reuse that project's queries.
 * Every write is best-effort: a broken or locked database must never fail a
 * model request, so all failures are swallowed and counted.
 * @module dsh-llm-antigravity-acp/metrics
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
let cachedConstructor;
/** Load `node:sqlite`; undefined on runtimes that ship it disabled. */
function loadDatabaseSync() {
    if (cachedConstructor !== undefined)
        return cachedConstructor ?? undefined;
    try {
        const req = createRequire(import.meta.url);
        const sqlite = req('node:sqlite');
        cachedConstructor = typeof sqlite.DatabaseSync === 'function' ? sqlite.DatabaseSync : null;
    }
    catch {
        cachedConstructor = null;
    }
    return cachedConstructor ?? undefined;
}
const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    base_model_id TEXT NOT NULL,
    last_acp_model_id TEXT NOT NULL,
    last_thinking_level TEXT NOT NULL,
    last_actual_model_version TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    turns INTEGER NOT NULL DEFAULT 0,
    hash_hits INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cached_read_tokens INTEGER NOT NULL DEFAULT 0,
    cached_write_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    thought_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cache_hit_rate REAL NOT NULL DEFAULT 0,
    avg_ttft_ms INTEGER NOT NULL DEFAULT 0,
    total_ttft_ms INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS requests (
    request_id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    session_cache TEXT NOT NULL,
    requested_model TEXT NOT NULL,
    resolved_base_model TEXT NOT NULL,
    thinking_level TEXT NOT NULL,
    acp_model_id TEXT NOT NULL,
    actual_model_version TEXT NOT NULL,
    ttft_ms INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    stream INTEGER NOT NULL,
    finish_reason TEXT NOT NULL,
    tool_calls_count INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    cached_read_tokens INTEGER NOT NULL,
    cached_write_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    thought_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    cache_hit_rate REAL NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_requests_session_id ON requests(session_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active_at DESC);
`;
/** Per-request cache-hit rate, percent with one decimal (0 when no prompt tokens). */
export function cacheHitRate(rec) {
    const prompt = rec.inputTokens + rec.cachedReadTokens + rec.cachedWriteTokens;
    return prompt > 0 ? Number(((rec.cachedReadTokens / prompt) * 100).toFixed(1)) : 0;
}
/** SQLite-backed telemetry writer. */
export class MetricsStore {
    db;
    failures = 0;
    /**
     * @param path - database file.
     * @param database - injected constructor (tests); defaults to `node:sqlite`.
     */
    constructor(path, database) {
        const Ctor = database ?? loadDatabaseSync();
        if (Ctor === undefined)
            throw new Error('node:sqlite is unavailable');
        mkdirSync(dirname(path), { recursive: true });
        this.db = new Ctor(path, { timeout: 3_000 });
        this.db.exec(SCHEMA);
        // Sessions from a previous process are not live any more.
        this.db.exec("UPDATE sessions SET status = 'CLOSED' WHERE status = 'ACTIVE'");
    }
    /**
     * Open the store, or report why it stays unavailable.
     * @param path - database file.
     * @returns the store, or undefined when sqlite is missing or the file is unusable.
     */
    static open(path) {
        try {
            return { store: new MetricsStore(path) };
        }
        catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    }
    /** Number of swallowed write failures (diagnostics). */
    get failureCount() {
        return this.failures;
    }
    /**
     * Record one finished request and fold it into its session row.
     * @param rec - request facts.
     */
    record(rec) {
        const hitRate = cacheHitRate(rec);
        try {
            this.db.prepare(`
        INSERT OR IGNORE INTO sessions (
          session_id, worker_id, base_model_id, last_acp_model_id,
          last_thinking_level, last_actual_model_version, created_at,
          last_active_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
      `).run(rec.sessionId, rec.workerId, rec.resolvedBaseModel, rec.acpModelId, rec.thinkingLevel, rec.actualModelVersion || rec.resolvedBaseModel, rec.timestamp, rec.timestamp);
            this.db.prepare(`
        INSERT OR REPLACE INTO requests (
          request_id, timestamp, session_id, worker_id, session_cache,
          requested_model, resolved_base_model, thinking_level, acp_model_id,
          actual_model_version, ttft_ms, duration_ms, stream, finish_reason,
          tool_calls_count, input_tokens, cached_read_tokens, cached_write_tokens,
          output_tokens, thought_tokens, total_tokens, cache_hit_rate, status, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(rec.requestId, rec.timestamp, rec.sessionId, rec.workerId, rec.sessionCache, rec.requestedModel, rec.resolvedBaseModel, rec.thinkingLevel, rec.acpModelId, rec.actualModelVersion, rec.ttftMs, rec.durationMs, rec.stream ? 1 : 0, rec.finishReason, rec.toolCallsCount, rec.inputTokens, rec.cachedReadTokens, rec.cachedWriteTokens, rec.outputTokens, rec.thoughtTokens, rec.totalTokens, hitRate, rec.status, rec.errorMessage ?? null);
            const existing = this.db.prepare(`
        SELECT turns, hash_hits, input_tokens, cached_read_tokens, cached_write_tokens,
               output_tokens, thought_tokens, total_tokens, total_ttft_ms
        FROM sessions WHERE session_id = ?
      `).get(rec.sessionId);
            if (existing !== undefined) {
                const turns = Number(existing.turns ?? 0) + 1;
                const hashHits = Number(existing.hash_hits ?? 0) + (rec.sessionCache === 'HIT' ? 1 : 0);
                const inputTokens = Number(existing.input_tokens ?? 0) + rec.inputTokens;
                const cachedReadTokens = Number(existing.cached_read_tokens ?? 0) + rec.cachedReadTokens;
                const cachedWriteTokens = Number(existing.cached_write_tokens ?? 0) + rec.cachedWriteTokens;
                const outputTokens = Number(existing.output_tokens ?? 0) + rec.outputTokens;
                const thoughtTokens = Number(existing.thought_tokens ?? 0) + rec.thoughtTokens;
                const totalTokens = Number(existing.total_tokens ?? 0) + rec.totalTokens;
                const totalTtftMs = Number(existing.total_ttft_ms ?? 0) + (rec.ttftMs > 0 ? rec.ttftMs : 0);
                const prompt = inputTokens + cachedReadTokens + cachedWriteTokens;
                this.db.prepare(`
          UPDATE sessions
          SET last_active_at = ?, last_acp_model_id = ?, last_thinking_level = ?,
              last_actual_model_version = ?, turns = ?, hash_hits = ?,
              input_tokens = ?, cached_read_tokens = ?, cached_write_tokens = ?,
              output_tokens = ?, thought_tokens = ?, total_tokens = ?,
              cache_hit_rate = ?, avg_ttft_ms = ?, total_ttft_ms = ?
          WHERE session_id = ?
        `).run(rec.timestamp, rec.acpModelId, rec.thinkingLevel, rec.actualModelVersion || rec.resolvedBaseModel, turns, hashHits, inputTokens, cachedReadTokens, cachedWriteTokens, outputTokens, thoughtTokens, totalTokens, prompt > 0 ? Number(((cachedReadTokens / prompt) * 100).toFixed(1)) : 0, turns > 0 ? Math.round(totalTtftMs / turns) : 0, totalTtftMs, rec.sessionId);
            }
        }
        catch {
            this.failures += 1;
        }
    }
    /**
     * Mark every live session closed.
     * @param sessionId - optional single session.
     */
    close(sessionId) {
        try {
            if (sessionId === undefined) {
                this.db.exec("UPDATE sessions SET status = 'CLOSED' WHERE status = 'ACTIVE'");
            }
            else {
                this.db.prepare("UPDATE sessions SET status = 'CLOSED', last_active_at = ? WHERE session_id = ?")
                    .run(Date.now(), sessionId);
            }
        }
        catch {
            this.failures += 1;
        }
    }
    /** Release the file handle. */
    dispose() {
        try {
            this.db.close();
        }
        catch {
            this.failures += 1;
        }
    }
}
