/**
 * Antigravity 面板与额度服务。
 *
 * 两个消费方向：
 *   - dsh-cost-meter 走 cliproxyapi 兼容契约（auth-files / api-call）与 /api/quota/gemini；
 *   - 面板 UI（M4）读同一份快照 + metrics.db（M3）。
 *
 * 默认 0.0.0.0:8788，只在内网 192.168.100.0/24 可达（LXC 不对外映射）。
 * @module antigravity-dashboard/server
 */

import http from 'node:http'
import { createUsageSource } from './agy.mjs'
import { apiCallEnvelope, authFiles, geminiSummary, DEFAULT_TIME_ZONE } from './contract.mjs'
import { openMetrics } from './metrics.mjs'
import { createPatchManager } from './patch.mjs'

const PORT = Number(process.env.DASHBOARD_PORT ?? 8788)
const HOST = process.env.DASHBOARD_HOST ?? '0.0.0.0'
const TIME_ZONE = process.env.DASHBOARD_TZ ?? DEFAULT_TIME_ZONE

/**
 * 写 JSON 响应。
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

const MAX_BODY_BYTES = 64 * 1024

/**
 * 读请求体并尽力解析成对象；读不完会卡住连接，所以无论内容如何都要读完。
 * @param {http.IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
function readJson(req) {
  return new Promise((resolve) => {
    let text = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (text.length < MAX_BODY_BYTES) text += chunk
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(text === '' ? '{}' : text)
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

/**
 * @param {{
 *   usage?: ReturnType<typeof createUsageSource>,
 *   patches?: ReturnType<typeof createPatchManager>,
 *   metrics?: ReturnType<typeof openMetrics>,
 * }} [options]
 */
export function createServer(options = {}) {
  const usage = options.usage ?? createUsageSource()
  const patches = options.patches ?? createPatchManager()
  const metrics = options.metrics ?? openMetrics()

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const route = `${req.method} ${url.pathname}`
    try {
      if (route === 'GET /healthz') {
        sendJson(res, 200, { status: 'ok', timeZone: TIME_ZONE })
        return
      }

      // cost-meter customBalances：5h 剩余百分比
      if (route === 'GET /api/quota/gemini' || route === 'GET /quota') {
        const snapshot = await usage.read(url.searchParams.get('force') === '1')
        sendJson(res, 200, geminiSummary(snapshot, { timeZone: TIME_ZONE }))
        return
      }

      // cost-meter 先拉账号列表（antigravity 适配器要求 provider + project_id）
      if (route === 'GET /v0/management/auth-files') {
        sendJson(res, 200, authFiles())
        return
      }

      // cost-meter gatewayQuotas：信封里再套一层 body 字符串，内层 status_code 表上游状态
      if (route === 'POST /v0/management/api-call') {
        await readJson(req)
        try {
          const snapshot = await usage.read()
          sendJson(res, 200, apiCallEnvelope(snapshot, { timeZone: TIME_ZONE }))
        } catch (error) {
          sendJson(res, 200, { status_code: 500, body: JSON.stringify({ error: message(error) }) })
        }
        return
      }

      // 上下文解锁开关：状态只读；开关必须显式 POST，服务自己不主动打补丁
      if (route === 'GET /api/context-unlock/status') {
        const status = await patches.status(url.searchParams.get('force') === '1')
        sendJson(res, 200, { ...status, restartRequired: true })
        return
      }

      if (route === 'POST /api/context-unlock') {
        const body = await readJson(req)
        if (typeof body.enable !== 'boolean') {
          sendJson(res, 400, { error: '需要 {"enable": true|false}' })
          return
        }
        try {
          const result = body.enable ? await patches.enable() : await patches.disable()
          sendJson(res, 200, { ...result, restartRequired: true })
        } catch (error) {
          const status = error?.code === 'CONFLICT' ? 409 : 500
          sendJson(res, status, { error: message(error) })
        }
        return
      }

      // 面板数据面：额度 + 遥测 + 解锁状态一次取齐（M4 四个页面共用）
      if (route === 'GET /api/admin/overview') {
        const [overview, unlock] = await Promise.all([
          Promise.resolve(metrics.overview({ recentLimit: Number(url.searchParams.get('recent') ?? 25) })),
          patches.status().catch(error => ({ locked: true, windowTokens: 256000, error: message(error) })),
        ])
        sendJson(res, 200, {
          generatedAt: new Date().toISOString(),
          metrics: overview,
          unlock,
          quota: await usage.read().then(snapshot => ({ status: 'ok', updatedAt: snapshot.updatedAt, groups: snapshot.groups }), error => ({ status: 'error', error: message(error) })),
        })
        return
      }

      if (route === 'GET /api/metrics/requests') {
        const overview = metrics.overview({ recentLimit: Number(url.searchParams.get('limit') ?? 100) })
        sendJson(res, 200, { available: overview.available, path: overview.path, requests: overview.recentRequests, error: overview.error })
        return
      }

      sendJson(res, 404, { error: 'Not found' })
    } catch (error) {
      console.error(`[dashboard] ${route} 失败:`, message(error))
      sendJson(res, 500, { error: message(error) })
    }
  })
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer()
  server.listen(PORT, HOST, () => {
    console.log(`[dashboard] Antigravity 面板与额度服务 listening on http://${HOST}:${PORT} (${TIME_ZONE})`)
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 3_000).unref()
    })
  }
}
