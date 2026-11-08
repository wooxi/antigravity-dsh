# Antigravity × DSH 实施方案

> 目标：让 DSH 用 `agy acp` 原生协议跑 Antigravity 模型（低封号风险），同时提供一个独立的监控面板服务，并向 `dsh-cost-meter` 供给账号额度。

## 一、背景与取舍

### 现状（改造前）

```
CPA 账号池 192.168.100.4:8045/api/accounts      ← OAuth 逆向，封号风险
        │
        ▼
antigravity-bridge :8046                        ← 已运行
        ├── GET  /api/quota/gemini              → cost-meter customBalances
        └── POST /v0/management/api-call        → cost-meter gatewayQuotas「Gemini Pro」
```

### 目标（改造后）

```
┌──────────────────────────────────────────────┐
│  dsh web :3080                               │
│  └─ packages/acp-provider（DSH 插件）          │
│       ├─ agy acp 原生 ACP v1（provider）       │
│       ├─ 工具/审批/子代理/用量 全走 DSH         │
│       └─ 写 metrics.db                        │
└──────────────────────────────────────────────┘
                     │ 单向只读
                     ▼
┌──────────────────────────────────────────────┐
│  packages/dashboard :8788（独立服务）          │
│  ├─ 面板 UI（照搬原项目 4 个页面）              │
│  ├─ GET  /api/quota/gemini        ← cost 用   │
│  ├─ POST /v0/management/api-call  ← cost 用   │
│  ├─ 直调 agy -p /usage 拿账号额度              │
│  ├─ 读 metrics.db 出图表                       │
│  └─ POST /api/context-unlock  补丁开关         │
└──────────────────────────────────────────────┘
```

### 关键取舍

| 决定 | 理由 |
|---|---|
| 基座用 `dsh-plugin-bundle/dsh-llm-antigravity-acp` | 真正的 DSH 一级 provider，工具/审批/子代理全保留 |
| 不用 `agy-acp2api` 接 DSH | 那是 agent 套 agent，会丢 DSH 的审批、子代理、思考流 |
| 面板独立成服务 | 用户要求：与 dsh web 无关，单独地址 |
| bridge 8046 原样保留 | 两条路并行，随时可切回 |
| 不自动 patch | 用户要求：必须前端开关触发 |

## 二、代码来源

| 组件 | 来源 | 用法 |
|---|---|---|
| ACP provider | `lili-luo/dsh-plugin-bundle` → `dsh-llm-antigravity-acp` | fork，改 3 处 |
| 上下文解锁 | 同仓库 `agy-context-unlock/agy-patch.py` | 原样放入，由开关触发 |
| 面板 UI | `chengdidididi/agy-acp2api` → `src/server/dashboard-ui.ts` | 移植，去掉 Google Fonts 外链 |
| metrics 表结构 | `agy-acp2api/src/telemetry/metrics-store.ts` | 照搬 schema |

## 三、数据契约（最关键，不能改）

cost-meter 的 ledger 里已经配好，**只允许改 baseURL**：

```json
{
  "id": "antigravity",
  "type": "cliproxyapi",
  "label": "Gemini Pro",
  "baseURL": "http://127.0.0.1:8788",
  "antigravityOnlyGemini": true
}
```

### 端点 1：`GET /api/quota/gemini`

```json
{
  "name": "Gemini (agy 原生)",
  "accounts_count": 1,
  "remaining": 87.3,
  "max_budget": 100,
  "five_hour_remaining_pct": 87.3,
  "weekly_remaining_pct": 80.1,
  "summary": "5h: 87.3% · 周: 80.1%",
  "next_reset_5h": "2026-11-08T15:00:00Z",
  "next_reset_weekly": "2026-11-11T00:00:00Z"
}
```

### 端点 2：`POST /v0/management/api-call`

请求体忽略。响应必须是**信封包 body 字符串**：

```json
{
  "status_code": 200,
  "body": "{\"groups\":[{\"id\":\"gemini-pool-weekly\",\"displayName\":\"重置 周一 00:00\",\"buckets\":[{\"window\":\"周\",\"remainingFraction\":0.801,\"resetTime\":\"...\"}]},{\"id\":\"gemini-pool-5h\",\"displayName\":\"重置 15:00\",\"buckets\":[{\"window\":\"5h\",\"remainingFraction\":0.873,\"resetTime\":\"...\"}]}]}"
}
```

注意：`groups` 为空时返回 `status_code: 404`；异常时 `status_code: 500` + `body` 里带 `error`。
`window` 字段原样输出到卡片，`周` 会显示成「周」。

### 数据来源

`agy -p /usage --output-format json`（**不消耗模型额度**，见上游 `src/quota.ts:106`）。
输出为 quota groups 数组，每个 group 含 buckets，bucket 有 `remaining_fraction` / `reset_time` / `window`。

## 四、任务拆解

### M0 · 基座跑通（0.5 天）

- [ ] fork `dsh-llm-antigravity-acp` 到 `packages/acp-provider`
- [ ] `npm install && npm run build && npm test`（上游自带 fake-agy 测试）
- [ ] 加 systemd drop-in 修 PATH：`Environment=PATH=/root/.local/bin:...`
- [ ] `dsh plugin --profile web add ./packages/acp-provider`
- [ ] **验收**：DSH 模型选择器里出现 Antigravity 分组（未解锁时 256K）

### M1 · 额度接口（0.5 天）

- [ ] `packages/dashboard` 骨架：Node + 原生 http，端口 8788
- [ ] 复用上游 `quota.ts` 的解析逻辑，调 `agy -p /usage`
- [ ] 实现两个契约端点
- [ ] **验收**：`curl 127.0.0.1:8788/api/quota/gemini` 返回真实额度；把 cost-meter 的 baseURL 改成 8788 后，「Gemini Pro」卡片数值与 8046 一致

### M2 · 补丁开关（0.5 天）

- [ ] 把 `agy-patch.py` 放进 `packages/dashboard/scripts/`
- [ ] `GET /api/context-unlock/status` → `{ locked: bool, windowTokens: number }`
- [ ] `POST /api/context-unlock` `{ enable: true|false }`
- [ ] enable：`python3 agy-patch.py --binary /root/.local/bin/agy --in-place`
- [ ] disable：从 `agy.bak` 还原
- [ ] 面板上加开关 + 提示「需重启 dsh-web 生效」
- [ ] **验收**：开关切换后 `--dry-run` 的 sha256 前后不同；重启 dsh-web 后插件声明 1,048,576

### M3 · metrics 落库（0.5 天）

- [ ] 插件侧写 `metrics.db`（`~/.dsh/cache/antigravity-acp/metrics.db`）
- [ ] 表结构照搬 acp2api：`sessions` / `requests`
- [ ] 采集 TTFT、duration、token（input/cached/output/thought）、cache_hit_rate、status
- [ ] 面板侧只读打开（`readonly: true`），避免锁竞争
- [ ] **验收**：跑几轮对话后 `requests` 表有数据，TTFT 合理

### M4 · 面板移植（1.5 天）

- [ ] 搬 `dashboard-ui.ts` 的 HTML/CSS/JS
- [ ] **去掉 Google Fonts 外链**（内网访问会卡 10s+），改系统字体栈
- [ ] 4 个页面：首页 / 请求 / 运行 / 设置
- [ ] `/api/admin/overview` 改成读本地 metrics.db + agy 额度
- [ ] 「运行」页的 worker 池改成「当前 ACP 会话数 + 模型 + 上下文窗口」
- [ ] **验收**：内网 `http://192.168.100.6:8788` 打开，4 个页面都有真实数据

### M5 · 联调与文档（0.5 天）

- [ ] cost-meter 切到 8788，观察 24h 数据是否对得上 8046
- [ ] 写 README（部署、回滚）
- [ ] 更新 `/root/lab-manual/CHANGELOG.md` + `05-ops-history.md`

## 五、风险

| 风险 | 影响 | 对策 |
|---|---|---|
| `agy` 升级后 patch 失效 | 上下文退回 256K | 面板开关重新打；状态接口显示 locked |
| Claude/GPT-OSS 白名单被上游收紧 | 只剩 Gemini | 插件本身能跑，只是模型变少 |
| `agy -p /usage` 与 `agy acp` 争抢 | 查询失败 | 加互斥锁 + 3 次重试 + 缓存 60s |
| 面板读 metrics.db 时写库锁 | 面板卡顿 | 只读打开 + WAL 模式 |
| 两套额度源数据不一致 | cost 显示错 | 并行跑一周再切 |

## 六、回滚

```sh
# 插件
dsh plugin --profile web remove dsh-antigravity-acp
# 补丁
python3 agy-patch.py --restore   # 或 cp agy.bak agy
# cost-meter
# 把 baseURL 改回 http://127.0.0.1:8046
# 面板
systemctl stop antigravity-dashboard
```

## 七、部署形态

| 组件 | 位置 | 启动方式 |
|---|---|---|
| acp-provider | `/dsh-workspace/feishu/antigravity-dsh/packages/acp-provider` | 由 dsh web 加载 |
| dashboard | 同仓库 `packages/dashboard` | systemd `antigravity-dashboard.service`，端口 8788，仅内网 |
