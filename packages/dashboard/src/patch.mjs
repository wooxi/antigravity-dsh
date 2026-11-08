/**
 * 上下文解锁开关（M2）。
 *
 * 纪律：**只由前端开关触发**。这里没有任何启动自检、没有定时任务、没有
 * `autoPatch`；插件侧的 `autoPatch` 已在 profile 配置里关掉，补丁脚本也不放在
 * 插件默认会去捡的路径上。
 *
 * 状态判定靠官方脚本自己的 `--dry-run`：
 *   - `all gates already unlocked` → 已解锁
 *   - `dry run complete: sha256 A -> B` → 仍锁在 256K
 * @module antigravity-dashboard/patch
 */

import { copyFileSync, existsSync, chmodSync, openSync, closeSync, readSync, statSync, unlinkSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCommand } from './agy.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** 官方默认窗口；解锁后插件声明 1,048,576。 */
export const LOCKED_CONTEXT_WINDOW = 256_000
export const UNLOCKED_CONTEXT_WINDOW = 1_048_576

/** 解锁脚本位置：随本服务发布，不写进插件默认路径。 */
export const PATCH_SCRIPT = process.env.AGY_PATCH_SCRIPT ?? join(here, '..', 'scripts', 'agy-patch.py')
const DEFAULT_BINARY = process.env.AGY_BINARY ?? '/root/.local/bin/agy'
const PYTHON = process.env.AGY_PATCH_PYTHON ?? '/usr/bin/python3'

/**
 * 状态冲突（备份过期、没有备份、状态不可判定）→ HTTP 409。
 * @param {string} message
 */
export function conflict(message) {
  const error = new Error(message)
  error.code = 'CONFLICT'
  return error
}

/**
 * 算文件 sha256（备份比对用，246MB 约 0.4s）。
 * @param {string} path
 * @returns {string|null}
 */
export function sha256File(path) {
  let fd
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024)
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
    }
    return hash.digest('hex')
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/**
 * 解析 `agy-patch.py --dry-run` 的输出。
 * @param {{code: number|null, stdout: string, stderr: string}} result
 * @returns {{state: 'unlocked'|'locked'|'unknown', before?: string, after?: string, detail: string}}
 */
export function parseDryRun(result) {
  const text = `${result.stdout}\n${result.stderr}`
  if (/all gates already unlocked/i.test(text)) {
    return { state: 'unlocked', detail: 'all gates already unlocked' }
  }
  const match = /dry run complete: sha256 ([0-9a-f]+) -> ([0-9a-f]+)/i.exec(text)
  if (match !== null) {
    return { state: 'locked', before: match[1], after: match[2], detail: 'binary still clamped to 256K' }
  }
  const line = text.split('\n').find(entry => /error:/i.test(entry))?.trim()
  return { state: 'unknown', detail: line ?? `unlock check inconclusive (exit ${result.code ?? 'null'})` }
}

/**
 * @param {{binary?: string, script?: string, python?: string, run?: typeof runCommand, statusTtlMs?: number, now?: () => number}} [options]
 */
export function createPatchManager(options = {}) {
  const binary = options.binary ?? DEFAULT_BINARY
  const script = options.script ?? PATCH_SCRIPT
  const python = options.python ?? PYTHON
  const run = options.run ?? runCommand
  const statusTtlMs = Number(options.statusTtlMs ?? process.env.PATCH_STATUS_TTL_MS ?? 10_000)
  const now = options.now ?? (() => Date.now())
  /** @type {Map<string, Promise<unknown>>} */
  const locks = new Map()
  /** @type {{at: number, value: unknown}|null} */
  let cachedStatus = null

  const backupPath = () => `${binary}.bak`

  /** 串行化同一类操作，避免连点两次触发并发改写。 */
  function serialize(key, job) {
    const previous = locks.get(key) ?? Promise.resolve()
    const next = previous.then(job, job)
    locks.set(key, next.catch(() => {}))
    return next
  }

  async function dryRun() {
    if (!existsSync(binary)) throw new Error(`agy 不存在：${binary}`)
    if (!existsSync(script)) throw new Error(`解锁脚本不存在：${script}`)
    const result = await run([python, script, '--binary', binary, '--dry-run'], 180_000)
    return parseDryRun(result)
  }

  async function readVersion() {
    try {
      const result = await run([binary, '--version'], 30_000)
      return (result.stdout.trim() || result.stderr.trim()).split('\n')[0] ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }

  async function inspect() {
    const check = await dryRun()
    const backup = backupPath()
    const hasBackup = existsSync(backup)
    const binarySha = sha256File(binary)
    const backupSha = hasBackup ? sha256File(backup) : null
    return {
      locked: check.state === 'locked',
      windowTokens: check.state === 'unlocked' ? UNLOCKED_CONTEXT_WINDOW : LOCKED_CONTEXT_WINDOW,
      state: check.state,
      binary,
      script,
      version: await readVersion(),
      backup: {
        path: backup,
        exists: hasBackup,
        // 备份和当前二进制不是同一份说明 agy 升级过，还原会把版本退回去
        matchesBinary: hasBackup && backupSha !== null && backupSha === binarySha,
      },
      detail: check.detail,
      dryRun: check,
      checkedAt: new Date(now()).toISOString(),
    }
  }

  return {
    binary,
    script,
    backupPath,
    /** 状态（带 10s 缓存，dry-run 要读 246MB 二进制）。 */
    async status(force = false) {
      if (!force && cachedStatus !== null && now() - cachedStatus.at < statusTtlMs) return cachedStatus.value
      const value = await inspect()
      cachedStatus = { at: now(), value }
      return value
    },
    /** 打补丁：只在「当前锁着 + 没有陈旧备份」时动手。 */
    async enable() {
      return serialize('patch', async () => {
        const before = await inspect()
        if (before.state === 'unlocked') {
          cachedStatus = null
          return { changed: false, ...before }
        }
        if (before.state !== 'locked') throw conflict(`无法确认二进制状态：${before.detail}`)
        if (before.backup.exists && !before.backup.matchesBinary) {
          throw conflict(`备份 ${before.backup.path} 与当前 agy 不是同一份（升级过？）；先把旧备份移走再解锁，否则还原会把版本退回去`)
        }
        const result = await run([python, script, '--binary', binary, '--in-place'], 300_000)
        if (result.code !== 0) {
          throw new Error(`解锁失败（退出码 ${result.code}）：${(result.stderr.trim() || result.stdout.trim()).split('\n').slice(-1)[0] ?? ''}`)
        }
        cachedStatus = null
        const after = await inspect()
        if (after.state !== 'unlocked') throw new Error(`补丁已写入但复核仍不是 unlocked：${after.detail}`)
        return { changed: true, ...after, output: result.stdout.trim() }
      })
    },
    /** 还原：用 `agy.bak` 原子替换回来，绝不用原地写（正在运行的进程会 ETXTBSY）。 */
    async disable() {
      return serialize('patch', async () => {
        const before = await inspect()
        if (before.state === 'locked') {
          cachedStatus = null
          return { changed: false, ...before }
        }
        const backup = backupPath()
        if (!existsSync(backup)) throw conflict(`没有备份可还原：${backup} 不存在`)
        const staged = `${binary}.restore.${process.pid}`
        copyFileSync(backup, staged)
        chmodSync(staged, statSync(backup).mode & 0o777)
        try {
          renameSync(staged, binary)
        } catch (error) {
          try { unlinkSync(staged) } catch { /* 清理失败不影响结论 */ }
          throw new Error(`还原失败：${error instanceof Error ? error.message : String(error)}`)
        }
        cachedStatus = null
        const after = await inspect()
        if (after.state === 'unlocked') throw new Error('已从备份还原，但复核仍是 unlocked；请人工确认二进制')
        return { changed: true, ...after }
      })
    },
  }
}
