/**
 * 只读读取插件写的 metrics.db（表结构与 acp2api 一致）。
 *
 * 写侧是 `packages/acp-provider`，用 WAL；这里一律 `readOnly: true` 打开，
 * 不建表、不写、不改 journal_mode，避免和插件抢锁。
 * @module antigravity-dashboard/metrics
 */

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

/** 默认库位置：与插件 `${DSH_HOME}/cache/antigravity-acp/metrics.db` 一致。 */
export const METRICS_PATH = process.env.METRICS_DB
  ?? `${process.env.DSH_HOME ?? '/root/.dsh'}/cache/antigravity-acp/metrics.db`

const SUM_COLUMNS = `
  COUNT(*) AS requests,
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(cached_read_tokens), 0) AS cached_read_tokens,
  COALESCE(SUM(cached_write_tokens), 0) AS cached_write_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(thought_tokens), 0) AS thought_tokens,
  COALESCE(SUM(total_tokens), 0) AS total_tokens,
  COALESCE(SUM(tool_calls_count), 0) AS tool_calls
`

/**
 * 行内合计 → 面板字段。
 * @param {Record<string, unknown>|undefined} row
 */
function totalsOf(row) {
  const requests = Number(row?.requests ?? 0)
  const prompt = Number(row?.input_tokens ?? 0) + Number(row?.cached_read_tokens ?? 0) + Number(row?.cached_write_tokens ?? 0)
  return {
    requests,
    successes: Number(row?.successes ?? 0),
    errors: Number(row?.errors ?? 0),
    inputTokens: Number(row?.input_tokens ?? 0),
    cachedReadTokens: Number(row?.cached_read_tokens ?? 0),
    cachedWriteTokens: Number(row?.cached_write_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    thoughtTokens: Number(row?.thought_tokens ?? 0),
    totalTokens: Number(row?.total_tokens ?? 0),
    toolCalls: Number(row?.tool_calls ?? 0),
    cacheHitRate: prompt > 0 ? Number(((Number(row?.cached_read_tokens ?? 0) / prompt) * 100).toFixed(1)) : 0,
    successRate: requests > 0 ? Number(((Number(row?.successes ?? 0) / requests) * 100).toFixed(1)) : 0,
  }
}

/**
 * 只读打开 metrics.db。
 * @param {string} [path]
 */
export function openMetrics(path = METRICS_PATH) {
  return {
    path,
    available: existsSync(path),
    /**
     * 概览：总量 / 今日 / 会话 / 最近请求 / 模型分布。
     * @param {{recentLimit?: number}} [options]
     */
    overview(options = {}) {
      const limit = Math.min(200, Math.max(1, Number(options.recentLimit ?? 25)))
      if (!existsSync(path)) {
        return { available: false, path, totals: totalsOf(), today: totalsOf(), sessions: { total: 0, active: 0 }, models: [], recentRequests: [], error: 'metrics.db 还不存在（插件尚未产生请求）' }
      }
      let db
      try {
        db = new DatabaseSync(path, { readOnly: true })
        const all = totalsOf(db.prepare(`SELECT ${SUM_COLUMNS} FROM requests`).get())
        // TTFT 单独算：只统计有输出的请求，避免把 0 也算进平均
        const ttft = db.prepare('SELECT COUNT(*) AS n, SUM(ttft_ms) AS total FROM requests WHERE ttft_ms > 0').get()
        all.avgTtftMs = Number(ttft?.n ?? 0) > 0 ? Math.round(Number(ttft.total) / Number(ttft.n)) : 0
        const startOfDay = new Date()
        startOfDay.setHours(0, 0, 0, 0)
        const today = totalsOf(db.prepare(`SELECT ${SUM_COLUMNS} FROM requests WHERE timestamp >= ?`).get(startOfDay.getTime()))
        const sessions = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active FROM sessions").get()
        const models = db.prepare(`
          SELECT requested_model AS model,
                 COUNT(*) AS requests,
                 COALESCE(SUM(total_tokens), 0) AS total_tokens,
                 MAX(timestamp) AS last_at
          FROM requests GROUP BY requested_model ORDER BY requests DESC
        `).all().map(row => ({
          model: String(row.model),
          requests: Number(row.requests),
          totalTokens: Number(row.total_tokens),
          lastAt: Number(row.last_at),
        }))
        const recentRequests = db.prepare(`
          SELECT request_id, timestamp, session_id, session_cache, requested_model,
                 thinking_level, ttft_ms, duration_ms, finish_reason, tool_calls_count,
                 input_tokens, cached_read_tokens, output_tokens, thought_tokens,
                 total_tokens, cache_hit_rate, status, error_message
          FROM requests ORDER BY timestamp DESC LIMIT ?
        `).all(limit).map(row => ({
          requestId: row.request_id,
          at: row.timestamp,
          sessionId: row.session_id,
          cache: row.session_cache,
          model: row.requested_model,
          effort: row.thinking_level,
          ttftMs: row.ttft_ms,
          durationMs: row.duration_ms,
          finishReason: row.finish_reason,
          toolCalls: row.tool_calls_count,
          inputTokens: row.input_tokens,
          cachedReadTokens: row.cached_read_tokens,
          outputTokens: row.output_tokens,
          thoughtTokens: row.thought_tokens,
          totalTokens: row.total_tokens,
          cacheHitRate: row.cache_hit_rate,
          status: row.status,
          error: row.error_message,
        }))
        return {
          available: true,
          path,
          totals: all,
          today,
          sessions: { total: Number(sessions?.total ?? 0), active: Number(sessions?.active ?? 0) },
          models,
          recentRequests,
        }
      } catch (error) {
        return { available: false, path, totals: totalsOf(), today: totalsOf(), sessions: { total: 0, active: 0 }, models: [], recentRequests: [], error: error instanceof Error ? error.message : String(error) }
      } finally {
        try { db?.close() } catch { /* 只读句柄关不掉不影响下一次 */ }
      }
    },
  }
}
