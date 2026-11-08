/**
 * 面板客户端：4 个页面，全部数据来自 GET /api/admin/overview。
 * 无框架、无外链、无字体请求；每 5 秒拉一次，失败退避到 15 秒。
 */
(function () {
  'use strict'

  var SPRITE = {
    home: '<path d="M3 10.5 12 3.5l9 7V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z"/>',
    traffic: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    runtime: '<rect x="7" y="7" width="10" height="10" rx="2"/><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3"/>',
    settings: '<path d="M4 7h6M16 7h4M4 12h10M20 12h0M4 17h4M12 17h8"/><circle cx="13" cy="7" r="2.2"/><circle cx="17" cy="12" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
    moon: '<path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z"/>',
    check: '<path d="M4 12.5l5 5L20 6"/>',
    alert: '<path d="M12 4 21 20H3Z"/><path d="M12 10v4M12 17v.01"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3 2"/>',
    zap: '<path d="M13 3 5 14h5l-1 7 8-11h-5Z"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l4.5 4.5"/>',
    db: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
    power: '<path d="M12 4v7"/><path d="M7.6 7a7 7 0 1 0 8.8 0"/>',
    link: '<path d="M10 13.5 14 9.5"/><path d="M12.5 6.5 14 5a3.5 3.5 0 0 1 5 5l-1.5 1.5"/><path d="M11.5 17.5 10 19a3.5 3.5 0 0 1-5-5l1.5-1.5"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    arrow: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
    message: '<path d="M4 5h16v11H9l-5 4Z"/>',
  }

  var $ = function (sel) { return document.querySelector(sel) }
  var state = {
    data: null,
    page: 'home',
    tab: 'req',
    query: '',
    syncAt: 0,
    timer: null,
    busy: false,
  }

  function ic(name, cls) {
    var body = SPRITE[name] || SPRITE.activity
    return '<svg class="ms' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + body + '</svg>'
  }

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  function num(value) {
    var n = Number(value || 0)
    if (!isFinite(n)) return '0'
    if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1) + 'M'
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'k'
    return String(Math.round(n))
  }

  function pct(value) {
    var n = Number(value)
    return isFinite(n) ? Math.round(n * 10) / 10 + '%' : '—'
  }

  function dur(ms) {
    var n = Number(ms || 0)
    if (n <= 0) return '—'
    if (n < 1000) return Math.round(n) + 'ms'
    if (n < 60000) return (n / 1000).toFixed(1) + 's'
    return Math.round(n / 60000) + 'm' + Math.round((n % 60000) / 1000) + 's'
  }

  function clockOf(ms) {
    if (!ms) return '—'
    var d = new Date(ms)
    var p = function (v) { return String(v).padStart(2, '0') }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  function hourOf(ms) {
    var d = new Date(ms)
    return String(d.getHours()).padStart(2, '0') + ':00'
  }

  function resetOf(iso) {
    if (!iso) return '—'
    var d = new Date(iso)
    if (isNaN(d.getTime())) return '—'
    var diff = d.getTime() - Date.now()
    if (diff <= 0) return '已过期'
    var mins = Math.round(diff / 60000)
    if (mins < 60) return mins + ' 分钟后'
    var hours = Math.floor(mins / 60)
    if (hours < 24) return hours + ' 小时 ' + (mins % 60) + ' 分后'
    return Math.floor(hours / 24) + ' 天 ' + (hours % 24) + ' 小时后'
  }

  function ring(fraction, label, sub) {
    var f = Math.min(1, Math.max(0, Number(fraction) || 0))
    var r = 22
    var c = 2 * Math.PI * r
    var color = f >= 0.5 ? 'var(--success)' : f >= 0.2 ? 'var(--warning)' : 'var(--error)'
    return '<div class="win">' +
      '<svg class="ring" width="58" height="58" viewBox="0 0 58 58">' +
      '<circle cx="29" cy="29" r="' + r + '" fill="none" stroke="var(--sc-highest)" stroke-width="6"/>' +
      '<circle cx="29" cy="29" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="6" stroke-linecap="round" ' +
      'stroke-dasharray="' + (c * f).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 29 29)"/>' +
      '</svg>' +
      '<div class="win-t"><div class="win-v">' + esc(pct(f * 100)) + '</div>' +
      '<div class="win-l">' + esc(label) + (sub ? ' · ' + esc(sub) : '') + '</div></div></div>'
  }

  function quotaPools() {
    var quota = state.data && state.data.quota
    if (!quota || quota.status !== 'ok') {
      return '<div class="card"><div class="card-h">' + ic('alert', 't-warn') + '额度不可用<span class="grow"></span>' +
        '<span class="chip t-plain">agy -p /usage</span></div>' +
        '<div class="empty">' + ic('alert') + '<span>' + esc((quota && quota.error) || 'agy /usage 调用失败') + '</span></div></div>'
    }
    var cards = quota.groups.map(function (group) {
      var five = null
      var week = null
      ;(group.buckets || []).forEach(function (b) {
        if (/week/i.test(b.window)) week = b
        else if (/5|five/i.test(b.window)) five = b
      })
      var body = ''
      if (five) body += ring(five.remainingFraction, '5h 窗口', resetOf(five.resetTime))
      if (week) body += ring(week.remainingFraction, '每周额度', resetOf(week.resetTime))
      return '<div class="pool"><div class="pool-h">' + ic(/gemini/i.test(group.name) ? 'zap' : 'activity', 't-primary') +
        '<span class="pool-n">' + esc(group.name) + '</span></div>' + body + '</div>'
    }).join('')
    return cards || '<div class="pool"><div class="empty">' + ic('alert') + '<span>没有额度组</span></div></div>'
  }

  function bars() {
    var series = (state.data && state.data.metrics && state.data.metrics.series) || []
    if (series.length === 0) return '<div class="empty">' + ic('db') + '<span>还没有请求数据</span></div>'
    var max = 1
    series.forEach(function (p) { if (p.requests > max) max = p.requests })
    var w = 720
    var h = 150
    var pad = 6
    var bw = (w - pad * 2) / series.length
    var parts = ['<svg class="bars" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">']
    parts.push('<line class="ax" x1="0" y1="' + (h - 1) + '" x2="' + w + '" y2="' + (h - 1) + '"/>')
    series.forEach(function (point, index) {
      var bh = max > 0 ? Math.round((point.requests / max) * (h - 22)) : 0
      var x = pad + index * bw + 1
      var y = h - 2 - bh
      if (bh > 0) {
        parts.push('<rect class="b' + (point.errors > 0 ? ' err' : '') + '" x="' + x.toFixed(1) + '" y="' + y + '" width="' + Math.max(2, bw - 3).toFixed(1) + '" height="' + Math.max(2, bh) + '" rx="3"/>')
      }
      if (index % 4 === 0) {
        parts.push('<text class="lbl" x="' + (x + bw / 2).toFixed(1) + '" y="' + (h - 4) + '" text-anchor="middle" transform="rotate(-0)">' + esc(hourOf(point.hourStart)) + '</text>')
      }
    })
    parts.push('</svg>')
    return parts.join('')
  }

  function statusChip(status) {
    if (status === 'success') return '<span class="chip t-ok">成功</span>'
    if (status === 'error') return '<span class="chip t-err">失败</span>'
    return '<span class="chip t-plain">' + esc(status || '—') + '</span>'
  }

  function homePage() {
    var m = (state.data && state.data.metrics) || {}
    var totals = m.totals || {}
    var today = m.today || {}
    var recent = (m.recentRequests || []).slice(0, 6)
    var html = ''
    html += '<div class="grid kpis">'
    html += '<div class="card kpi"><div class="kpi-head">' + ic('activity', 't-primary') + '今日请求</div>' +
      '<div class="kpi-body"><span class="kpi-val">' + num(today.requests) + '</span></div>' +
      '<div class="kpi-foot">总计 ' + num(totals.requests) + ' · 失败 ' + num(today.errors) + '</div></div>'
    html += '<div class="card kpi"><div class="kpi-head">' + ic('db', 't-tertiary') + 'Token</div>' +
      '<div class="kpi-body"><span class="kpi-val">' + num(today.totalTokens) + '</span></div>' +
      '<div class="kpi-foot">输入 ' + num(today.inputTokens) + ' · 缓存 ' + num(today.cachedReadTokens) + ' · 输出 ' + num(today.outputTokens) + '</div></div>'
    html += '<div class="card kpi"><div class="kpi-head">' + ic('clock', 't-secondary') + '平均 TTFT</div>' +
      '<div class="kpi-body"><span class="kpi-val sm">' + dur(totals.avgTtftMs) + '</span></div>' +
      '<div class="kpi-foot">思考 ' + num(today.thoughtTokens) + ' tokens</div></div>'
    html += '<div class="card kpi"><div class="kpi-head">' + ic('check', 't-ok') + '缓存命中</div>' +
      '<div class="kpi-body"><span class="kpi-val sm">' + pct(totals.cacheHitRate) + '</span></div>' +
      '<div class="kpi-foot">成功率 ' + pct(totals.successRate) + '</div></div>'
    html += '</div>'

    html += '<div class="pools">' + quotaPools() + '</div>'

    html += '<div class="grid two">'
    html += '<div class="card"><div class="card-h">' + ic('activity', 't-primary') + '近 24 小时请求<span class="grow"></span>' +
      '<span class="legend"><span><i style="background:var(--primary)"></i>成功</span><span><i style="background:var(--error)"></i>含失败</span></span></div>' + bars() + '</div>'
    html += '<div class="card"><div class="card-h">' + ic('traffic', 't-secondary') + '最近请求<span class="grow"></span>' +
      '<button class="btn text" data-act="nav" data-page="traffic">全部' + ic('arrow') + '</button></div>'
    if (recent.length === 0) html += '<div class="empty">' + ic('db') + '<span>还没有请求</span></div>'
    else {
      html += '<div class="rows"><div class="row row-h"><span>时间</span><span>模型</span><span class="num">TTFT</span><span class="num">时长</span><span class="num">Token</span><span>状态</span></div>'
      recent.forEach(function (r) {
        html += '<div class="row"><span class="mono muted">' + esc(clockOf(r.at)) + '</span>' +
          '<span>' + esc(r.model) + ' <span class="muted">· ' + esc(r.effort) + '</span></span>' +
          '<span class="num">' + dur(r.ttftMs) + '</span>' +
          '<span class="num">' + dur(r.durationMs) + '</span>' +
          '<span class="num">' + num(r.totalTokens) + '</span>' +
          '<span>' + statusChip(r.status) + '</span></div>'
      })
      html += '</div>'
    }
    html += '</div></div>'
    return html
  }

  function filterRows(rows) {
    var q = state.query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(function (row) {
      return [row.model, row.effort, row.status, row.sessionId, row.requestId, row.finishReason]
        .some(function (value) { return String(value || '').toLowerCase().indexOf(q) >= 0 })
    })
  }

  function requestsTable() {
    var m = (state.data && state.data.metrics) || {}
    var rows = filterRows(m.recentRequests || [])
    if (rows.length === 0) return '<div class="empty">' + ic('search') + '<span>' + (state.query ? '没有匹配的请求' : '还没有请求数据') + '</span></div>'
    var html = '<table class="tbl"><thead><tr><th>时间</th><th>模型 / 档位</th><th>缓存</th><th class="r">TTFT</th><th class="r">时长</th>' +
      '<th class="r">输入</th><th class="r">缓存读</th><th class="r">输出</th><th class="r">思考</th><th class="r">工具</th><th>结束原因</th><th>状态</th></tr></thead><tbody>'
    rows.forEach(function (r) {
      html += '<tr title="' + esc(r.requestId) + '">' +
        '<td class="mono muted">' + esc(clockOf(r.at)) + '</td>' +
        '<td>' + esc(r.model) + ' <span class="muted">· ' + esc(r.effort) + '</span></td>' +
        '<td><span class="chip ' + (r.cache === 'HIT' ? 't-ok' : 't-plain') + '">' + esc(r.cache) + '</span></td>' +
        '<td class="r num">' + dur(r.ttftMs) + '</td><td class="r num">' + dur(r.durationMs) + '</td>' +
        '<td class="r num">' + num(r.inputTokens) + '</td><td class="r num">' + num(r.cachedReadTokens) + '</td>' +
        '<td class="r num">' + num(r.outputTokens) + '</td><td class="r num">' + num(r.thoughtTokens) + '</td>' +
        '<td class="r num">' + num(r.toolCalls) + '</td>' +
        '<td class="mono muted">' + esc(r.finishReason) + '</td>' +
        '<td>' + statusChip(r.status) + (r.error ? ' <span class="chip t-err" title="' + esc(r.error) + '">!</span>' : '') + '</td>' +
        '</tr>'
    })
    return html + '</tbody></table>'
  }

  function sessionsTable() {
    var m = (state.data && state.data.metrics) || {}
    var rows = filterRows(m.sessionsList || [])
    if (rows.length === 0) return '<div class="empty">' + ic('message') + '<span>' + (state.query ? '没有匹配的会话' : '还没有会话') + '</span></div>'
    var html = '<table class="tbl"><thead><tr><th>会话</th><th>模型 / 档位</th><th class="r">轮次</th><th class="r">缓存命中轮</th>' +
      '<th class="r">Token</th><th class="r">缓存率</th><th class="r">平均 TTFT</th><th>最后活跃</th><th>状态</th></tr></thead><tbody>'
    rows.forEach(function (s) {
      html += '<tr><td class="mono">' + esc(String(s.sessionId).slice(0, 8)) + '</td>' +
        '<td>' + esc(s.model) + ' <span class="muted">· ' + esc(s.effort) + '</span></td>' +
        '<td class="r num">' + num(s.turns) + '</td><td class="r num">' + num(s.hashHits) + '</td>' +
        '<td class="r num">' + num(s.totalTokens) + '</td><td class="r num">' + pct(s.cacheHitRate) + '</td>' +
        '<td class="r num">' + dur(s.avgTtftMs) + '</td>' +
        '<td class="mono muted">' + esc(clockOf(s.lastActiveAt)) + '</td>' +
        '<td><span class="chip ' + (s.status === 'ACTIVE' ? 't-ok' : 't-plain') + '">' + esc(s.status) + '</span></td></tr>'
    })
    return html + '</tbody></table>'
  }

  function trafficPage() {
    var card = state.tab === 'req' ? requestsTable() : sessionsTable()
    return '<div class="toolbar"><div class="seg" id="traffic-tabs">' +
      '<button data-act="tab" data-tab="req" class="' + (state.tab === 'req' ? 'on' : '') + '">' + ic('traffic') + '请求</button>' +
      '<button data-act="tab" data-tab="sess" class="' + (state.tab === 'sess' ? 'on' : '') + '">' + ic('message') + '会话</button>' +
      '</div><span class="grow"></span>' +
      '<label class="search">' + ic('search') + '<input id="q" placeholder="筛选模型 / 状态 / 会话" value="' + esc(state.query) + '" autocomplete="off"/></label>' +
      '</div><div class="card" style="padding:0"><div class="tbl-wrap" id="traffic-body">' + card + '</div></div>'
  }

  function runtimePage() {
    var m = (state.data && state.data.metrics) || {}
    var unlock = (state.data && state.data.unlock) || {}
    var catalog = (state.data && state.data.catalog) || {}
    var sessions = m.sessions || {}
    var html = '<div class="grid kpis">'
    html += '<div class="card kpi"><div class="kpi-head">' + ic('power', 't-ok') + 'ACP 活会话</div>' +
      '<div class="kpi-body"><span class="kpi-val">' + num(sessions.active) + '</span></div>' +
      '<div class="kpi-foot">历史会话 ' + num(sessions.total) + '</div></div>'
    html += '<div class="card kpi"><div class="kpi-head">' + ic('db', 't-primary') + '上下文窗口</div>' +
      '<div class="kpi-body"><span class="kpi-val sm">' + num(unlock.windowTokens) + '</span></div>' +
      '<div class="kpi-foot">' + (unlock.locked ? '官方 256K 上限' : '已解锁 ~1M') + '</div></div>'
    html += '<div class="card kpi"><div class="kpi-head">' + ic('runtime', 't-secondary') + 'agy 版本</div>' +
      '<div class="kpi-body"><span class="kpi-val sm">' + esc(unlock.version || '—') + '</span></div>' +
      '<div class="kpi-foot mono">' + esc(unlock.binary || '') + '</div></div>'
    html += '<div class="card kpi"><div class="kpi-head">' + ic('zap', 't-tertiary') + '可用模型</div>' +
      '<div class="kpi-body"><span class="kpi-val sm">' + num((catalog.models || []).length) + '</span></div>' +
      '<div class="kpi-foot">' + esc((catalog.efforts || []).join(' / ') || '—') + '</div></div>'
    html += '</div>'

    html += '<div class="card"><div class="card-h">' + ic('runtime', 't-primary') + '模型目录<span class="grow"></span>' +
      '<span class="chip t-plain mono">' + esc(catalog.path || '') + '</span></div>'
    if (!catalog.available) html += '<div class="empty">' + ic('db') + '<span>' + esc(catalog.error || '目录不可用') + '</span></div>'
    else {
      html += '<div class="rows"><div class="row row-h"><span>模型 id</span><span>显示名</span><span class="num">请求数</span><span class="num">Token</span><span>可用档位</span><span>最后请求</span></div>'
      var stats = {}
      ;(m.models || []).forEach(function (entry) { stats[entry.model] = entry })
      catalog.models.forEach(function (model) {
        var stat = stats[model.id] || {}
        var efforts = (catalog.byModel && catalog.byModel[model.id]) || catalog.efforts || []
        html += '<div class="row"><span class="mono">' + esc(model.id) + '</span><span>' + esc(model.name) + '</span>' +
          '<span class="num">' + num(stat.requests) + '</span><span class="num">' + num(stat.totalTokens) + '</span>' +
          '<span class="muted">' + esc(efforts.join(' / ') || '—') + '</span>' +
          '<span class="mono muted">' + esc(stat.lastAt ? clockOf(stat.lastAt) : '—') + '</span></div>'
      })
      html += '</div>'
    }
    html += '</div>'

    html += '<div class="card" style="padding:0"><div class="card-h" style="padding:20px 20px 0">' + ic('message', 't-secondary') + '会话</div>' +
      '<div class="tbl-wrap">' + sessionsTable() + '</div></div>'
    return html
  }

  function settingsPage() {
    var unlock = (state.data && state.data.unlock) || {}
    var backup = unlock.backup || {}
    var dry = unlock.dryRun || {}
    var m = (state.data && state.data.metrics) || {}
    var html = ''
    html += '<div class="card switch-card"><div class="card-h">' + ic('settings', 't-primary') + '上下文解锁' +
      '<span class="grow"></span><span class="chip ' + (unlock.locked ? 't-plain' : 't-ok') + '">' +
      (unlock.locked ? '锁定 256K' : '已解锁 1M') + '</span></div>'
    html += '<div class="switch-row">' +
      '<button class="btn ' + (unlock.locked ? 'filled' : 'outlined') + '" data-act="unlock" data-enable="' + (unlock.locked ? '1' : '0') + '"' +
      (state.busy ? ' disabled' : '') + '>' + ic(unlock.locked ? 'zap' : 'power') +
      (unlock.locked ? '解锁到 1M' : '还原官方 256K') + '</button>' +
      '<span class="tabs-note">改写的是本机 <span class="mono">agy</span> 二进制；' +
      (unlock.locked ? '解锁后' : '还原后') + '需要 <strong>重启 dsh-web</strong> 才会生效。</span></div>'
    if (backup.exists) {
      html += '<div class="switch-row"><span class="chip ' + (backup.matchesBinary ? 't-ok' : 't-warn') + '">' +
        (backup.matchesBinary ? '备份与当前二进制一致' : '备份与当前二进制不一致') + '</span>' +
        '<span class="mono muted">' + esc(backup.path || '') + '</span></div>'
    }
    html += '<dl class="kv-grid">' +
      '<dt>状态</dt><dd>' + esc(unlock.state || '—') + ' · ' + esc(unlock.detail || '') + '</dd>' +
      '<dt>dry-run</dt><dd>' + esc(dry.state === 'locked' ? ('sha256 ' + dry.before + ' -> ' + dry.after) : (dry.detail || '—')) + '</dd>' +
      '<dt>二进制</dt><dd>' + esc(unlock.binary || '—') + '</dd>' +
      '<dt>解锁脚本</dt><dd>' + esc(unlock.script || '—') + '</dd>' +
      '<dt>检查时间</dt><dd>' + esc(clockOf(Date.parse(unlock.checkedAt || ''))) + '</dd>' +
      '</dl></div>'

    html += '<div class="card"><div class="card-h">' + ic('link', 't-secondary') + '接口</div><dl class="kv-grid">' +
      '<dt>额度（cost-meter）</dt><dd>GET /api/quota/gemini</dd>' +
      '<dt>网关信封</dt><dd>POST /v0/management/api-call</dd>' +
      '<dt>账号列表</dt><dd>GET /v0/management/auth-files</dd>' +
      '<dt>面板数据</dt><dd>GET /api/admin/overview</dd>' +
      '<dt>解锁状态</dt><dd>GET /api/context-unlock/status</dd>' +
      '<dt>解锁开关</dt><dd>POST /api/context-unlock {"enable":true|false}</dd>' +
      '</dl></div>'

    html += '<div class="card"><div class="card-h">' + ic('db', 't-tertiary') + '本地数据</div><dl class="kv-grid">' +
      '<dt>metrics.db</dt><dd>' + esc(m.path || '—') + (m.available ? '' : ' （不可用：' + esc(m.error || '') + '）') + '</dd>' +
      '<dt>请求总数</dt><dd>' + num((m.totals || {}).requests) + '</dd>' +
      '<dt>会话总数</dt><dd>' + num((m.sessions || {}).total) + '</dd>' +
      '<dt>主题</dt><dd><button class="btn text" data-act="theme">切换明/暗</button></dd>' +
      '</dl></div>'
    return html
  }

  var PAGES = {
    home: { title: '首页', render: homePage },
    traffic: { title: '请求', render: trafficPage },
    runtime: { title: '运行', render: runtimePage },
    settings: { title: '设置', render: settingsPage },
  }

  function renderNav() {
    document.querySelectorAll('.nav-item').forEach(function (item) {
      item.classList.toggle('active', item.dataset.page === state.page)
    })
  }

  function renderSync() {
    var ok = state.data !== null
    var text = ok ? '已同步 · ' + new Date(state.syncAt).toLocaleTimeString('zh-CN', { hour12: false }) : '连接中'
    ;['#sync', '#sync-top'].forEach(function (sel) {
      var node = $(sel)
      if (node) node.textContent = text
    })
    ;['#sync-dot', '#sync-dot-top'].forEach(function (sel) {
      var node = $(sel)
      if (!node) return
      node.style.background = ok ? 'var(--success)' : 'var(--error)'
    })
  }

  function render() {
    renderNav()
    renderSync()
    var page = PAGES[state.page] || PAGES.home
    var node = $('#page-body')
    if (node) node.innerHTML = page.render()
    var title = $('#page-title')
    if (title) title.textContent = page.title
    var badge = $('#badge-rt')
    if (badge) {
      var active = ((state.data && state.data.metrics && state.data.metrics.sessions) || {}).active || 0
      badge.textContent = active > 0 ? String(active) : ''
      badge.classList.toggle('on', active > 0)
    }
  }

  function showPage(page) {
    if (!PAGES[page]) page = 'home'
    state.page = page
    if (location.hash !== '#' + page) history.replaceState(null, '', '#' + page)
    render()
  }

  function snack(text, isError) {
    var node = $('#snack')
    if (!node) return
    node.textContent = text
    node.className = 'snack on' + (isError ? ' err' : '')
    clearTimeout(snack.timer)
    snack.timer = setTimeout(function () { node.className = 'snack' }, 3200)
  }

  function load(force) {
    return fetch('/api/admin/overview' + (force ? '?force=1' : ''), { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      })
      .then(function (data) {
        state.data = data
        state.syncAt = Date.now()
        render()
      })
      .catch(function (error) {
        var node = $('#sync')
        if (node) node.textContent = '同步失败：' + error.message
        var dot = $('#sync-dot')
        if (dot) dot.style.background = 'var(--error)'
      })
      .finally(schedule)
  }

  function schedule() {
    clearTimeout(state.timer)
    state.timer = setTimeout(function () { load(false) }, state.data === null ? 15000 : 5000)
  }

  function toggleUnlock(enable) {
    state.busy = true
    render()
    snack(enable ? '正在解锁，可能需要几秒…' : '正在还原…')
    fetch('/api/context-unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enable: enable }),
    })
      .then(function (response) { return response.json().then(function (body) { return { status: response.status, body: body } }) })
      .then(function (result) {
        if (result.status !== 200) throw new Error(result.body.error || ('HTTP ' + result.status))
        snack(result.body.changed ? (enable ? '已解锁，重启 dsh-web 后生效' : '已还原 256K，重启 dsh-web 后生效') : '状态未变化')
      })
      .catch(function (error) { snack(error.message, true) })
      .finally(function () {
        state.busy = false
        load(true)
      })
  }

  document.addEventListener('click', function (event) {
    var nav = event.target.closest('[data-act="nav"]')
    if (nav) {
      event.preventDefault()
      showPage(nav.dataset.page)
      return
    }
    var tab = event.target.closest('[data-act="tab"]')
    if (tab) {
      state.tab = tab.dataset.tab
      render()
      return
    }
    var unlock = event.target.closest('[data-act="unlock"]')
    if (unlock) {
      toggleUnlock(unlock.dataset.enable === '1')
      return
    }
    if (event.target.closest('[data-act="refresh"]')) {
      load(true)
      return
    }
    if (event.target.closest('[data-act="theme"]')) {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
      document.documentElement.setAttribute('data-theme', next)
      localStorage.setItem('agy-theme', next)
      document.querySelectorAll('[data-act="theme"]').forEach(function (node) {
        node.innerHTML = ic(next === 'dark' ? 'sun' : 'moon')
      })
    }
  })

  document.addEventListener('input', function (event) {
    if (event.target.id !== 'q') return
    state.query = event.target.value
    var body = $('#traffic-body')
    if (body) body.innerHTML = state.tab === 'req' ? requestsTable() : sessionsTable()
  })

  window.addEventListener('hashchange', function () {
    showPage(location.hash.replace('#', ''))
  })

  // 主题与图标初始化
  var saved = localStorage.getItem('agy-theme')
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved)
  document.querySelectorAll('[data-act="theme"]').forEach(function (node) {
    node.innerHTML = ic(document.documentElement.getAttribute('data-theme') === 'dark' ? 'sun' : 'moon')
  })
  ;(function paintIcons() {
    document.querySelectorAll('[data-ic]').forEach(function (node) {
      node.innerHTML = ic(node.dataset.ic)
    })
  })()

  showPage((location.hash || '#home').replace('#', ''))
  load(false)
})()
