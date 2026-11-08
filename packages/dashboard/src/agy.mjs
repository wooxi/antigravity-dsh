/**
 * 通过官方 CLI 的本地 `/usage` 命令读账号额度（不发送模型请求、不消耗额度）。
 * 与 `agy acp` 共用同一个登录态，因此查询失败按「暂态」处理：串行化 + 重试 + 缓存。
 * @module antigravity-dashboard/agy
 */

import { spawn } from 'node:child_process'

/** 默认 agy 路径；PATHEXT/PATH 兜底交给部署方的 systemd 单元。 */
export const DEFAULT_BINARY = '/root/.local/bin/agy'
const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_CACHE_MS = 60_000
const DEFAULT_ATTEMPTS = 3
const MAX_OUTPUT_BYTES = 1_000_000

/**
 * 解析 `agy -p /usage --output-format json` 的 stdout。
 * 结构：`command.data.groups[]`，每个 group 有 `buckets[]`，
 * bucket 字段是 `remaining_fraction` / `reset_time` / `window`。
 * @param {string} stdout 命令标准输出
 * @returns {{name: string, description: string, buckets: {id: string, name: string, window: string, remainingFraction: number, resetTime: string}[]}[]}
 */
export function parseUsage(stdout) {
  const parsed = JSON.parse(stdout)
  const groups = parsed?.command?.data?.groups
  if (!Array.isArray(groups)) throw new Error('agy /usage 没有返回 quota groups')
  return groups.map((raw) => {
    const group = raw ?? {}
    return {
      name: String(group.name ?? ''),
      description: String(group.description ?? ''),
      buckets: (Array.isArray(group.buckets) ? group.buckets : []).map((entry) => {
        const bucket = entry ?? {}
        return {
          id: String(bucket.id ?? ''),
          name: String(bucket.name ?? ''),
          window: String(bucket.window ?? ''),
          remainingFraction: typeof bucket.remaining_fraction === 'number' ? bucket.remaining_fraction : 0,
          resetTime: String(bucket.reset_time ?? ''),
        }
      }),
    }
  })
}

/**
 * 跑一条命令并收集输出，超时直接 kill。
 * @param {string[]} argv 命令与参数
 * @param {number} timeoutMs 超时
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
export function runCommand(argv, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const [file, ...args] = argv
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`${file} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 额度读取器：并发请求合并成一次执行，结果缓存 TTL，失败重试。
 * @param {{binary?: string, cacheMs?: number, attempts?: number, timeoutMs?: number, run?: typeof runCommand}} [options]
 */
export function createUsageSource(options = {}) {
  const binary = options.binary ?? process.env.AGY_BINARY ?? DEFAULT_BINARY
  const cacheMs = Number(options.cacheMs ?? process.env.USAGE_CACHE_MS ?? DEFAULT_CACHE_MS)
  const attempts = Number(options.attempts ?? process.env.USAGE_ATTEMPTS ?? DEFAULT_ATTEMPTS)
  const timeoutMs = Number(options.timeoutMs ?? process.env.USAGE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  const run = options.run ?? runCommand
  /** @type {{at: number, snapshot: {updatedAt: string, groups: unknown[]}}|null} */
  let cached = null
  /** @type {Promise<{updatedAt: string, groups: unknown[]}>|null} */
  let inflight = null

  async function fetchOnce() {
    const result = await run([binary, '-p', '/usage', '--output-format', 'json'], timeoutMs)
    if (result.code !== 0) {
      const detail = (result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? ''
      throw new Error(`agy /usage 退出码 ${result.code}${detail.length > 0 ? `: ${detail}` : ''}`)
    }
    return { updatedAt: new Date().toISOString(), groups: parseUsage(result.stdout) }
  }

  return {
    binary,
    /**
     * 读一次额度快照。
     * @param {boolean} [force] 跳过缓存
     */
    async read(force = false) {
      if (!force && cached !== null && Date.now() - cached.at < cacheMs) return cached.snapshot
      if (inflight === null) {
        inflight = (async () => {
          let lastError
          for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
              const snapshot = await fetchOnce()
              cached = { at: Date.now(), snapshot }
              return snapshot
            } catch (error) {
              lastError = error
              if (attempt + 1 < attempts) await sleep(400 * (attempt + 1))
            }
          }
          throw lastError instanceof Error ? lastError : new Error(String(lastError))
        })().finally(() => { inflight = null })
      }
      return inflight
    },
    /** 丢弃缓存。 */
    invalidate() { cached = null },
  }
}
