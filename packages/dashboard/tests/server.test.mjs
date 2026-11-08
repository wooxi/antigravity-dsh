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
async function boot(usage, patches) {
  const server = createServer(patches === undefined ? { usage } : { usage, patches })
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

/** 只记录调用、不碰磁盘的补丁管理器替身。 */
function fakePatches() {
  const calls = []
  return {
    calls,
    async status() { return { locked: true, windowTokens: 256000, state: 'locked', binary: '/root/.local/bin/agy', backup: { exists: false } } },
    async enable() { calls.push('enable'); return { changed: true, locked: false, windowTokens: 1048576 } },
    async disable() { calls.push('disable'); return { changed: true, locked: true, windowTokens: 256000 } },
  }
}

test('GET /api/context-unlock/status 报 locked/256K 并提示需重启', async () => {
  const app = await boot(okUsage, fakePatches())
  try {
    const body = await (await fetch(`${app.base}/api/context-unlock/status`)).json()
    assert.equal(body.locked, true)
    assert.equal(body.windowTokens, 256000)
    assert.equal(body.restartRequired, true)
  } finally {
    await app.close()
  }
})

test('POST /api/context-unlock 只有显式 enable 才动补丁', async () => {
  const patches = fakePatches()
  const app = await boot(okUsage, patches)
  try {
    const enable = await fetch(`${app.base}/api/context-unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enable: true }),
    })
    assert.equal(enable.status, 200)
    assert.equal((await enable.json()).windowTokens, 1048576)

    const disable = await fetch(`${app.base}/api/context-unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enable: false }),
    })
    assert.equal(disable.status, 200)
    assert.deepEqual(patches.calls, ['enable', 'disable'])
  } finally {
    await app.close()
  }
})

test('POST /api/context-unlock 缺 enable 字段回 400，且不动补丁', async () => {
  const patches = fakePatches()
  const app = await boot(okUsage, patches)
  try {
    const response = await fetch(`${app.base}/api/context-unlock`, { method: 'POST', body: '{}' })
    assert.equal(response.status, 400)
    assert.deepEqual(patches.calls, [])
  } finally {
    await app.close()
  }
})

test('冲突状态回 409', async () => {
  const conflict = new Error('备份与当前 agy 不是同一份')
  conflict.code = 'CONFLICT'
  const app = await boot(okUsage, {
    async status() { return { locked: true } },
    async enable() { throw conflict },
    async disable() { throw conflict },
  })
  try {
    const response = await fetch(`${app.base}/api/context-unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enable: true }),
    })
    assert.equal(response.status, 409)
    assert.match((await response.json()).error, /不是同一份/)
  } finally {
    await app.close()
  }
})
