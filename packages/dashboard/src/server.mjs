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

/**
 * 读掉请求体（我们不看内容，但必须读完否则连接不释放）。
 * @param {http.IncomingMessage} req
 */
function drain(req) {
  return new Promise((resolve) => {
    req.on('data', () => {})
    req.on('end', resolve)
    req.on('error', resolve)
  })
}

/**
 * @param {{usage?: ReturnType<typeof createUsageSource>}} [options]
 */
export function createServer(options = {}) {
  const usage = options.usage ?? createUsageSource()

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
        await drain(req)
        try {
          const snapshot = await usage.read()
          sendJson(res, 200, apiCallEnvelope(snapshot, { timeZone: TIME_ZONE }))
        } catch (error) {
          sendJson(res, 200, { status_code: 500, body: JSON.stringify({ error: message(error) }) })
        }
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
