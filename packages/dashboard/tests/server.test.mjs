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
async function boot(usage, patches, metrics) {
  const server = createServer({ usage, ...(patches === undefined ? {} : { patches }), ...(metrics === undefined ? {} : { metrics }) })
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
    async status() { return { locked: true, windowTokens: 256000, state: 'locked', binary: '/root/.local/bin/agy', backup: { exists: false }, dryRun: { state: 'locked' } } },
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

/** 假遥测读取器：只证明路由把数据拼起来，真实 SQL 由 metrics 自己的测试覆盖。 */
function fakeMetrics(overrides = {}) {
  return {
    path: '/tmp/fake-metrics.db',
    overview() {
      return {
        available: true,
        path: '/tmp/fake-metrics.db',
        totals: { requests: 3, avgTtftMs: 5608, cacheHitRate: 12.5, totalTokens: 26903 },
        today: { requests: 3 },
        sessions: { total: 3, active: 0 },
        models: [{ model: 'gemini-3.8-flash', requests: 3, totalTokens: 26903, lastAt: 1794142324550 }],
        series: [],
        sessionsList: [{ sessionId: 'sess-1', model: 'gemini-3.8-flash', status: 'CLOSED', turns: 1 }],
        recentRequests: [],
        ...overrides,
      }
    },
  }
}

test('GET /api/admin/overview 拼额度 + 遥测 + 解锁状态', async () => {
  const app = await boot(okUsage, fakePatches(), fakeMetrics())
  try {
    const body = await (await fetch(`${app.base}/api/admin/overview`)).json()
    assert.equal(body.metrics.totals.requests, 3)
    assert.equal(body.unlock.windowTokens, 256000)
    assert.equal(body.quota.status, 'ok')
    assert.equal(body.quota.groups.length, 2)
    assert.equal(body.quota.groups[0].name, 'Gemini Models')
  } finally {
    await app.close()
  }
})

test('GET /api/admin/overview 在 agy 挂掉时 quota 标注 error，不拖垮整页', async () => {
  const app = await boot(brokenUsage, fakePatches(), fakeMetrics())
  try {
    const body = await (await fetch(`${app.base}/api/admin/overview`)).json()
    assert.equal(body.quota.status, 'error')
    assert.match(body.quota.error, /boom/)
    assert.equal(body.metrics.available, true)
  } finally {
    await app.close()
  }
})

test('GET /api/metrics/requests 传 limit', async () => {
  const app = await boot(okUsage, fakePatches(), fakeMetrics({ recentRequests: [{ requestId: 'r1' }] }))
  try {
    const body = await (await fetch(`${app.base}/api/metrics/requests?limit=5`)).json()
    assert.equal(body.available, true)
    assert.equal(body.requests.length, 1)
  } finally {
    await app.close()
  }
})

test('面板 HTML 零外链：没有 Google Fonts / CDN，样式与脚本都在本机', async () => {
  const app = await boot(okUsage, fakePatches(), fakeMetrics())
  try {
    const html = await (await fetch(`${app.base}/`)).text()
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic|cdn\.|unpkg|jsdelivr/i)
    assert.doesNotMatch(html, /<script[^>]+src="https?:/)
    assert.match(html, /href="\/assets\/app\.css"/)
    assert.match(html, /src="\/assets\/app\.js"/)
    assert.match(html, /data-ic="home"/)
    const css = await (await fetch(`${app.base}/assets/app.css`)).text()
    assert.doesNotMatch(css, /@import|fonts\.googleapis|Material Symbols/i)
    assert.match(css, /system-ui/)
    const js = await (await fetch(`${app.base}/assets/app.js`)).text()
    assert.doesNotMatch(js, /https?:\/\//)
    assert.match(js, /\/api\/admin\/overview/)
  } finally {
    await app.close()
  }
})

test('/dashboard 与 /assets 缺失文件的行为', async () => {
  const app = await boot(okUsage, fakePatches(), fakeMetrics())
  try {
    assert.equal((await fetch(`${app.base}/dashboard`)).status, 200)
    assert.equal((await fetch(`${app.base}/assets/nope.js`)).status, 404)
  } finally {
    await app.close()
  }
})

test('overview 提供面板四个页面用到的字段', async () => {
  const app = await boot(okUsage, fakePatches(), fakeMetrics())
  try {
    const body = await (await fetch(`${app.base}/api/admin/overview`)).json()
    for (const key of ['generatedAt', 'metrics', 'unlock', 'quota', 'catalog']) assert.ok(key in body, `缺 ${key}`)
    assert.ok('series' in body.metrics && 'sessionsList' in body.metrics && 'recentRequests' in body.metrics)
    assert.ok('models' in body.catalog && 'path' in body.catalog)
    assert.ok('locked' in body.unlock && 'windowTokens' in body.unlock && 'backup' in body.unlock && 'dryRun' in body.unlock)
    assert.ok('groups' in body.quota && 'updatedAt' in body.quota)
  } finally {
    await app.close()
  }
})

test('面板 logo 的 data URI 完整可解码（图标不裂）', async () => {
  const app = await boot(okUsage, fakePatches(), fakeMetrics())
  try {
    const html = await (await fetch(`${app.base}/`)).text()
    const img = /<img class="brand-logo"[^>]*src="([^"]+)"/.exec(html)
    assert.ok(img, '找不到 brand-logo 的 src')
    const dataUri = img[1]
    assert.match(dataUri, /^data:image\/svg\+xml,/)
    const svg = decodeURIComponent(dataUri.slice('data:image/svg+xml,'.length))
    // 关键：属性值里不能出现裸的 < > "，否则 HTML 会在引号处截断
    assert.doesNotMatch(decodeURIComponent(dataUri), /^\s*<svg[^>]*$/)
    assert.ok(svg.trim().endsWith('</svg>'), `SVG 被截断：${svg}`)
    assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
    assert.ok(!dataUri.includes('"'))
    const icon = /<link rel="icon" href="([^"]+)"/.exec(html)
    assert.ok(icon && icon[1] === dataUri)
  } finally {
    await app.close()
  }
})
