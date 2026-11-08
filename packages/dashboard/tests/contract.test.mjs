import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseUsage } from '../src/agy.mjs'
import {
  apiCallEnvelope,
  authFiles,
  geminiSummary,
  overview,
  percent,
  resetLabel,
} from '../src/contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const usageText = readFileSync(join(here, 'fixtures', 'usage.json'), 'utf8')

const snapshot = () => ({ updatedAt: '2026-11-08T12:58:40.000Z', groups: parseUsage(usageText) })

test('parseUsage 读出两个额度组与四个窗口', () => {
  const groups = parseUsage(usageText)
  assert.deepEqual(groups.map(group => group.name), ['Gemini Models', 'Claude and GPT models'])
  assert.deepEqual(groups[0].buckets.map(bucket => bucket.window), ['weekly', '5h'])
  assert.equal(groups[0].buckets[0].remainingFraction, 0.9997507333755493)
  assert.equal(groups[0].buckets[0].resetTime, '2026-11-15T11:58:40Z')
})

test('parseUsage 对残缺输出直接报错，不编造额度', () => {
  assert.throws(() => parseUsage('{"command":{"data":{}}}'), /quota groups/)
})

test('percent 保一位小数并夹到 0–1', () => {
  assert.equal(percent(0.9997507333755493), 100)
  assert.equal(percent(0.9991274476051331), 99.9)
  assert.equal(percent(1.5), 100)
  assert.equal(percent(-1), 0)
  assert.equal(percent(Number.NaN), 0)
})

test('resetLabel 按账号时区出中文星期与时钟', () => {
  assert.equal(resetLabel('2026-11-15T11:58:40Z', 'date', 'Asia/Shanghai'), '周日 19:58')
  assert.equal(resetLabel('2026-11-08T16:58:40Z', 'time', 'Asia/Shanghai'), '00:58')
  assert.equal(resetLabel('', 'time', 'Asia/Shanghai'), '')
  assert.equal(resetLabel('not-a-date', 'time', 'Asia/Shanghai'), '')
})

test('GET /api/quota/gemini 契约：字段齐全且 5h 为 remaining', () => {
  const summary = geminiSummary(snapshot(), { timeZone: 'Asia/Shanghai' })
  assert.equal(summary.name, 'Gemini (agy 原生)')
  assert.equal(summary.accounts_count, 1)
  assert.equal(summary.max_budget, 100)
  assert.equal(summary.remaining, 99.9)
  assert.equal(summary.five_hour_remaining_pct, 99.9)
  assert.equal(summary.weekly_remaining_pct, 100)
  assert.equal(summary.summary, '5h: 99.9% · 周: 100%')
  assert.equal(summary.next_reset_5h, '2026-11-08T16:58:40Z')
  assert.equal(summary.next_reset_weekly, '2026-11-15T11:58:40Z')
})

test('GET /api/quota/gemini 缺 Gemini 组时报错，不退化成假额度', () => {
  const onlyThirdParty = { updatedAt: 'x', groups: parseUsage(usageText).filter(group => !/gemini/i.test(group.name)) }
  assert.throws(() => geminiSummary(onlyThirdParty), /Gemini/)
})

test('POST /v0/management/api-call 信封：200 + 内层 body 字符串', () => {
  const envelope = apiCallEnvelope(snapshot(), { timeZone: 'Asia/Shanghai' })
  assert.equal(envelope.status_code, 200)
  assert.equal(typeof envelope.body, 'string')
  const payload = JSON.parse(envelope.body)
  assert.deepEqual(payload.groups.map(group => group.id), [
    'gemini-pool-weekly',
    'gemini-pool-5h',
    'third-party-pool-weekly',
    'third-party-pool-5h',
  ])
  assert.deepEqual(payload.groups.map(group => group.buckets[0].window), ['周', '5h', '周', '5h'])
  // 两行必须等长（周也不写星期），否则 cost-meter 的进度条不对齐
  assert.deepEqual(payload.groups.map(group => group.displayName), [
    '重置 19:58',
    '重置 00:58',
    'Claude/GPT · 重置 00:09',
    'Claude/GPT · 重置 01:06',
  ])
  const labels = payload.groups.map(group => group.displayName.length)
  assert.equal(labels[0], labels[1], 'Gemini 两行标签长度不一致')
  assert.equal(labels[2], labels[3], 'Claude/GPT 两行标签长度不一致')
  // 契约要求 remainingFraction 是 0–1 份额，不是百分比
  assert.equal(payload.groups[0].buckets[0].remainingFraction, 0.9997507333755493)
  assert.equal(payload.groups[0].buckets[0].resetTime, '2026-11-15T11:58:40Z')
})

test('POST /v0/management/api-call 无可用 bucket 时回 404 信封', () => {
  const envelope = apiCallEnvelope({ updatedAt: 'x', groups: [] })
  assert.equal(envelope.status_code, 404)
  assert.match(JSON.parse(envelope.body).error, /no quota buckets/)
})

test('auth-files 带 antigravity 适配器要求的 provider 与 project_id', () => {
  const payload = authFiles()
  assert.equal(payload.files.length, 1)
  const [file] = payload.files
  assert.equal(file.provider, 'antigravity')
  assert.equal(typeof file.auth_index, 'string')
  assert.equal(typeof file.project_id, 'string')
  assert.equal(file.disabled, false)
})

test('overview 给面板两个池、两种窗口', () => {
  const view = overview(snapshot(), { timeZone: 'Asia/Shanghai' })
  assert.equal(view.pools.length, 2)
  assert.equal(view.pools[0].name, 'Gemini Models')
  assert.equal(view.pools[0].fiveHour.percent, 99.9)
  assert.equal(view.pools[0].weekly.label, '重置 周日 19:58')
  assert.equal(view.pools[1].fiveHour.label, '重置 01:06')
})

// 真实消费方回归：把本服务的信封丢给 dsh-cost-meter 自己的 antigravity 解析器。
const costMeterLib = process.env.COST_METER_LIB ?? '/root/.dsh/profiles/web/node_modules/dsh-cost-meter/lib'
const adaptersPath = join(costMeterLib, 'gateway-quota-adapters.js')
const costMeterInstalled = existsSync(adaptersPath)

test('dsh-cost-meter 的 antigravity 解析器吃得下本服务的信封', { skip: costMeterInstalled ? false : `未安装 cost-meter（${adaptersPath}）` }, async () => {
  const { parseAntigravityQuota } = await import(pathToFileURL(adaptersPath).href)
  const envelope = apiCallEnvelope(snapshot(), { timeZone: 'Asia/Shanghai' })
  const parsed = parseAntigravityQuota(JSON.parse(envelope.body), { geminiOnly: true })
  assert.deepEqual(parsed.windows.map(window => window.id), ['gemini-pool-weekly:周', 'gemini-pool-5h:five-hour'])
  assert.deepEqual(parsed.windows.map(window => window.label), ['重置 19:58 · 周', '重置 00:58 · 5h'])
  // percent 是「已用」方向：(1 − 0.99975) × 100
  assert.ok(Math.abs(parsed.windows[0].percent - 0.02) < 0.05)
  assert.equal(parsed.windows[1].periodHours, 5)
  // 周窗口按 PLAN 契约原样输出「周」，cost-meter 不认这个字样，periodHours 只能为 null
  // （旧 bridge 8046 的输出同样如此，卡片显示的仍是「周」）。
  assert.equal(parsed.windows[0].periodHours, null)
})
