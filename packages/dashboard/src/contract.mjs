/**
 * 数据契约层：把 agy 的 quota groups 映射成 dsh-cost-meter 与面板要的形状。
 * 契约见 PLAN.md §三，消费方实现见 dsh-cost-meter 的 gateway-quotas.js —
 * 形状不允许随意改动，只有数值来源换成本机 agy。
 * @module antigravity-dashboard/contract
 */

/** 面板/契约默认时区（重置时刻按账号本地时间展示）。 */
export const DEFAULT_TIME_ZONE = process.env.DASHBOARD_TZ ?? 'Asia/Shanghai'

/**
 * 取某个窗口的 bucket。
 * @param {{buckets: {window: string}[]}} group
 * @param {'weekly'|'5h'} kind
 */
export function windowBucket(group, kind) {
  const pattern = kind === 'weekly' ? /week/i : /5|five/i
  return group.buckets.find(bucket => pattern.test(bucket.window))
}

/**
 * 选额度组：Gemini 组与「Claude / GPT」第三方组。
 * @param {{name: string}[]} groups
 * @param {'gemini'|'third'} which
 */
export function pickGroup(groups, which) {
  if (which === 'gemini') return groups.find(group => /gemini/i.test(group.name))
  return groups.find(group => !/gemini/i.test(group.name))
}

/**
 * 0–1 份额 → 一位小数的剩余百分比。
 * @param {number} fraction
 */
export function percent(fraction) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0))
  return Math.round(clamped * 1000) / 10
}

/**
 * 重置时刻 → 卡片标签文本。
 * @param {string} iso 重置时刻
 * @param {'date'|'time'} style `date` 出「周一 00:00」，`time` 出「00:00」
 * @param {string} [timeZone]
 * @returns {string} 空串表示时刻不可用
 */
export function resetLabel(iso, style, timeZone = DEFAULT_TIME_ZONE) {
  if (iso === undefined || iso === null || iso === '') return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const read = type => parts.find(part => part.type === type)?.value ?? ''
  const clock = `${read('hour')}:${read('minute')}`
  return style === 'date' ? `${read('weekday')} ${clock}` : clock
}

/**
 * 两个窗口的剩余百分比与重置时刻。
 * @param {{buckets: {window: string, remainingFraction: number, resetTime: string}[]}} group
 */
export function poolWindows(group) {
  const weekly = windowBucket(group, 'weekly')
  const fiveHour = windowBucket(group, '5h')
  return {
    weekly: weekly === undefined ? undefined : { percent: percent(weekly.remainingFraction), resetTime: weekly.resetTime },
    fiveHour: fiveHour === undefined ? undefined : { percent: percent(fiveHour.remainingFraction), resetTime: fiveHour.resetTime },
  }
}

/**
 * GET /api/quota/gemini —— cost-meter customBalances 契约。
 * @param {{groups: {name: string, buckets: unknown[]}[], updatedAt: string}} snapshot
 * @param {{timeZone?: string}} [options]
 */
export function geminiSummary(snapshot, options = {}) {
  const group = pickGroup(snapshot.groups, 'gemini')
  if (group === undefined) throw new Error('agy /usage 没有返回 Gemini 额度组')
  const windows = poolWindows(group)
  const fiveHour = windows.fiveHour?.percent ?? 0
  const weekly = windows.weekly?.percent ?? 0
  return {
    name: 'Gemini (agy 原生)',
    accounts_count: 1,
    remaining: fiveHour,
    max_budget: 100,
    five_hour_remaining_pct: fiveHour,
    weekly_remaining_pct: weekly,
    summary: `5h: ${fiveHour}% · 周: ${weekly}%`,
    next_reset_5h: windows.fiveHour?.resetTime ?? '',
    next_reset_weekly: windows.weekly?.resetTime ?? '',
    updated_at: snapshot.updatedAt,
  }
}

/**
 * POST /v0/management/api-call 的 groups 列表。
 * 每组只放一个 bucket（与旧 bridge 一致）：卡片标签是「组名 · 窗口」，
 * 一个组塞两个窗口会让重置时刻互相打架。
 * @param {{groups: {name: string, buckets: {window: string, remainingFraction: number, resetTime: string}[]}[], updatedAt: string}} snapshot
 * @param {{timeZone?: string}} [options]
 */
export function quotaGroups(snapshot, options = {}) {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE
  const groups = []
  for (const [prefix, which, title] of [['gemini-pool', 'gemini', '重置'], ['third-party-pool', 'third', 'Claude/GPT · 重置']]) {
    const group = pickGroup(snapshot.groups, which)
    if (group === undefined) continue
    for (const [suffix, kind, label] of [['weekly', 'weekly', '周'], ['5h', '5h', '5h']]) {
      const bucket = windowBucket(group, kind)
      if (bucket === undefined) continue
      const resetAt = bucket.resetTime
      const labelStyle = kind === 'weekly' ? 'date' : 'time'
      groups.push({
        id: `${prefix}-${suffix}`,
        displayName: resetAt.length > 0 ? `${title} ${resetLabel(resetAt, labelStyle, timeZone)}` : '剩余额度',
        buckets: [{
          window: label,
          remainingFraction: Math.min(1, Math.max(0, bucket.remainingFraction)),
          resetTime: resetAt,
        }],
      })
    }
  }
  return groups
}

/**
 * POST /v0/management/api-call 的信封。消费方要求 HTTP 200 + 内层 status_code。
 * @param {{groups: unknown[], updatedAt: string}} snapshot
 * @param {{timeZone?: string}} [options]
 */
export function apiCallEnvelope(snapshot, options = {}) {
  const groups = quotaGroups(snapshot, options)
  if (groups.length === 0) {
    return { status_code: 404, body: JSON.stringify({ error: 'no quota buckets available' }) }
  }
  return { status_code: 200, body: JSON.stringify({ groups }) }
}

/**
 * GET /v0/management/auth-files —— cost-meter 先发现账号再逐个查额度，
 * 没有这个列表它会直接判定 CPA_RESPONSE_INVALID。
 * `provider`/`project_id` 是 antigravity 适配器的硬性前置条件。
 */
export function authFiles() {
  return {
    files: [{
      auth_index: 'agy-local',
      provider: 'antigravity',
      type: 'antigravity',
      email: 'agy@localhost',
      label: 'agy 本机登录',
      project_id: 'antigravity',
      disabled: false,
      status: 'active',
    }],
  }
}

/**
 * 发给面板的概览（M4 用，先留好数据形状）。
 * @param {{groups: {name: string, description: string, buckets: {window: string, remainingFraction: number, resetTime: string}[]}[], updatedAt: string}} snapshot
 * @param {{timeZone?: string}} [options]
 */
export function overview(snapshot, options = {}) {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE
  const pools = snapshot.groups.map((group) => {
    const windows = poolWindows(group)
    return {
      name: group.name,
      description: group.description,
      weekly: windows.weekly === undefined ? null : { percent: windows.weekly.percent, resetAt: windows.weekly.resetTime, label: `重置 ${resetLabel(windows.weekly.resetTime, 'date', timeZone)}` },
      fiveHour: windows.fiveHour === undefined ? null : { percent: windows.fiveHour.percent, resetAt: windows.fiveHour.resetTime, label: `重置 ${resetLabel(windows.fiveHour.resetTime, 'time', timeZone)}` },
    }
  })
  return { updatedAt: snapshot.updatedAt, timeZone, pools }
}
