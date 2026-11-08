/**
 * Plugin configuration. Fields marked volatile are live settings: the Web
 * settings surface edits them through the profile patch and the next request
 * reads the new value without restarting the plugin.
 * @module dsh-llm-antigravity-acp/config
 */
import z from '@deepseek-ai/schemastery';
/** Reasoning effort ids accepted by the Antigravity ACP `thought_level` option. */
export const EFFORTS = ['low', 'medium', 'high'];
function maybeVolatile(schema) {
    const candidate = schema;
    return typeof candidate.volatile === 'function' ? candidate.volatile() : schema;
}
/** Configuration schema. */
export const Config = z.object({
    provider: z.string().default('antigravity'),
    displayName: z.string().default('Antigravity'),
    command: z.string().default(''),
    home: z.string().default(''),
    contextWindow: maybeVolatile(z.number().step(1).min(0).default(0)),
    defaultEffort: maybeVolatile(z.union(EFFORTS).default('high')),
    autoPatch: z.boolean().default(true),
    patchScript: z.string().default(''),
    maxLiveSessions: z.number().step(1).min(1).max(64).default(16),
    idleSessionTtlMs: z.number().step(1).min(10_000).default(30 * 60_000),
    parkSettleMs: z.number().step(1).min(0).max(5_000).default(250),
    keepAliveMs: z.number().step(1).min(1_000).default(15_000),
    relayAfterMs: z.number().step(1).min(5_000).max(165_000).default(85_000),
    longDecodeContinuations: maybeVolatile(z.number().step(1).min(0).max(16).default(3)),
    warmup: z.boolean().default(true),
    quotaTtlMs: z.number().step(1).min(5_000).default(120_000),
    // The published schemastery declarations type `.volatile()` fields as plain values.
});
/**
 * Read the current value of one possibly-volatile field.
 * @param value - plain value or volatile reference.
 * @returns the current value.
 */
export function current(value) {
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
        return value.get();
    }
    return value;
}
/**
 * Narrow an arbitrary effort id to an Antigravity effort.
 * @param value - requested effort id.
 * @returns the effort, or undefined when Antigravity does not offer it.
 */
export function asEffort(value) {
    return EFFORTS.includes(value ?? '') ? value : undefined;
}
