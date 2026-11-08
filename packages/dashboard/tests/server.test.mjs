import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseUsage } from '../src/agy.mjs'
import { createServer } from '../src/server.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const groups = parseUsage(readFileSync(join(here, 'fixtures', 'usage.json'), 'utf8'))

/** 起一个用假 usage 源的服务，返回基址与关闭函数。 */
async function boot(usage) {
  const server = createServer({ usage })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

const okUsage = { read: async () => ({ updatedAt: '2026-11-08T12:58:40.000Z', groups }) }
const brokenUsage = { read: async () => { throw new Error('agy /usage 退出码 1: boom') } }

test('GET /healthz', async () => {
  const app = await boot(okUsage)
  try {
    const response = await fetch(`${app.base}/healthz`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).status, 'ok')
  } finally {
    await app.close()
  }
})

test('GET /api/quota/gemini 返回真实额度形状', async () => {
  const app = await boot(okUsage)
  try {
    const response = await fetch(`${app.base}/api/quota/gemini`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.five_hour_remaining_pct, 99.9)
    assert.equal(body.weekly_remaining_pct, 100)
    assert.equal(body.max_budget, 100)
  } finally {
    await app.close()
  }
})

test('POST /v0/management/api-call 读掉请求体并回信封', async () => {
  const app = await boot(okUsage)
  try {
    const response = await fetch(`${app.base}/v0/management/api-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Management-Key': 'whatever' },
      body: JSON.stringify({ auth_index: 'agy-local', method: 'POST', url: 'https://example.invalid/quota' }),
    })
    assert.equal(response.status, 200)
    const envelope = await response.json()
    assert.equal(envelope.status_code, 200)
    assert.equal(JSON.parse(envelope.body).groups.length, 4)
  } finally {
    await app.close()
  }
})

test('agy 失败时 api-call 回 500 信封、gemini 回 500', async () => {
  const app = await boot(brokenUsage)
  try {
    const envelope = await (await fetch(`${app.base}/v0/management/api-call`, { method: 'POST', body: '' })).json()
    assert.equal(envelope.status_code, 500)
    assert.match(JSON.parse(envelope.body).error, /boom/)

    const summary = await fetch(`${app.base}/api/quota/gemini`)
    assert.equal(summary.status, 500)
    assert.match((await summary.json()).error, /boom/)
  } finally {
    await app.close()
  }
})

test('GET /v0/management/auth-files 返回单账号池', async () => {
  const app = await boot(okUsage)
  try {
    const body = await (await fetch(`${app.base}/v0/management/auth-files`)).json()
    assert.equal(body.files.length, 1)
    assert.equal(body.files[0].provider, 'antigravity')
  } finally {
    await app.close()
  }
})

test('未知路径 404', async () => {
  const app = await boot(okUsage)
  try {
    const response = await fetch(`${app.base}/nope`)
    assert.equal(response.status, 404)
  } finally {
    await app.close()
  }
})
