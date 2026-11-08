import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { MetricsStore, cacheHitRate } from '../lib/metrics.js'

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'agy-metrics-'))
  return { dir, path: join(dir, 'metrics.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const record = (overrides = {}) => ({
  requestId: 'req-1',
  timestamp: 1_700_000_000_000,
  sessionId: 'sess-1',
  workerId: 'agy-acp',
  sessionCache: 'MISS',
  requestedModel: 'gemini-3.8-flash',
  resolvedBaseModel: 'gemini-3.8-flash',
  thinkingLevel: 'high',
  acpModelId: 'gemini-3.8-flash',
  actualModelVersion: '1.5.3',
  ttftMs: 400,
  durationMs: 2_500,
  stream: true,
  finishReason: 'stop',
  toolCallsCount: 0,
  inputTokens: 100,
  cachedReadTokens: 300,
  cachedWriteTokens: 0,
  outputTokens: 50,
  thoughtTokens: 20,
  totalTokens: 450,
  status: 'success',
  ...overrides,
})

test('cacheHitRate 按三桶提示量算，空提示为 0', () => {
  assert.equal(cacheHitRate({ inputTokens: 100, cachedReadTokens: 300, cachedWriteTokens: 0 }), 75)
  assert.equal(cacheHitRate({ inputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 }), 0)
})

test('record 落 requests 与 sessions 两张表', () => {
  const box = tempDb()
  try {
    const { store, error } = MetricsStore.open(box.path)
    assert.equal(error, undefined)
    store.record(record())
    store.record(record({ requestId: 'req-2', timestamp: 1_700_000_100_000, sessionCache: 'HIT', ttftMs: 600, outputTokens: 80, totalTokens: 480 }))
    store.dispose()

    const db = new DatabaseSync(box.path, { readOnly: true })
    try {
      const rows = db.prepare('SELECT request_id, ttft_ms, duration_ms, status, cache_hit_rate, total_tokens FROM requests ORDER BY timestamp').all()
      assert.equal(rows.length, 2)
      assert.equal(rows[0].ttft_ms, 400)
      assert.equal(rows[0].duration_ms, 2500)
      assert.equal(rows[0].status, 'success')
      assert.equal(rows[0].cache_hit_rate, 75)
      assert.equal(rows[1].cache_hit_rate, 75)

      const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('sess-1')
      assert.equal(session.turns, 2)
      assert.equal(session.hash_hits, 1)
      assert.equal(session.input_tokens, 200)
      assert.equal(session.cached_read_tokens, 600)
      assert.equal(session.output_tokens, 130)
      assert.equal(session.thought_tokens, 40)
      assert.equal(session.status, 'ACTIVE')
      assert.equal(session.avg_ttft_ms, 500)
      assert.equal(session.last_acp_model_id, 'gemini-3.8-flash')
      assert.equal(session.last_thinking_level, 'high')
    } finally {
      db.close()
    }
  } finally {
    box.cleanup()
  }
})

test('错误请求也留痕，带 error_message', () => {
  const box = tempDb()
  try {
    const { store } = MetricsStore.open(box.path)
    store.record(record({ status: 'error', errorMessage: 'QUOTA: exhausted', finishReason: 'error' }))
    store.dispose()

    const db = new DatabaseSync(box.path, { readOnly: true })
    try {
      const row = db.prepare('SELECT status, error_message, finish_reason FROM requests').get()
      assert.equal(row.status, 'error')
      assert.equal(row.error_message, 'QUOTA: exhausted')
      assert.equal(row.finish_reason, 'error')
      const session = db.prepare('SELECT turns FROM sessions').get()
      assert.equal(session.turns, 1)
    } finally {
      db.close()
    }
  } finally {
    box.cleanup()
  }
})

test('重开时把上一进程遗留的 ACTIVE 会话关掉', () => {
  const box = tempDb()
  try {
    const first = MetricsStore.open(box.path)
    first.store.record(record())
    first.store.dispose()
    assert.ok(existsSync(box.path))

    const second = MetricsStore.open(box.path)
    second.store.dispose()
    const db = new DatabaseSync(box.path, { readOnly: true })
    try {
      assert.equal(db.prepare('SELECT status FROM sessions').get().status, 'CLOSED')
    } finally {
      db.close()
    }
  } finally {
    box.cleanup()
  }
})

test('写库失败只计数，不向调用方抛', () => {
  const box = tempDb()
  try {
    const { store } = MetricsStore.open(box.path)
    store.dispose()
    store.record(record())
    assert.equal(store.failureCount, 1)
  } finally {
    box.cleanup()
  }
})
