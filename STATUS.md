# 进度看板

> 执行会话每完成一项就更新本文件。青梧定时读取本文件向主人汇报。
> 格式约定：`- [ ]` 未开始 / `- [~]` 进行中 / `- [x]` 已完成 / `- [!]` 阻塞

**当前阶段**：M1（额度接口）完成 → M2
**最后更新**：2026-11-08 21:10
**执行会话**：DeepSeek Harness（本会话）

---

## 状态摘要

| 阶段 | 状态 | 备注 |
|---|---|---|
| M0 基座跑通 | 4/5，验收待重启 | 插件已装进 web profile，真实对话已通 |
| M1 额度接口 | 完成 | 8788 已上线，cost-meter 客户端实测 ok |
| M2 补丁开关 | 待开始 | |
| M3 metrics 落库 | 待开始 | |
| M4 面板移植 | 待开始 | |
| M5 联调文档 | 待开始 | |

## M0 明细

- [x] fork `dsh-llm-antigravity-acp` 到 `packages/acp-provider`（上游 `lili-luo/dsh-plugin-bundle@f049913`）
- [x] `npm install && npm run build && npm test` → build 通过，测试 47/47 通过
- [x] 加 systemd drop-in 修 PATH → `/etc/systemd/system/dsh-web.service.d/20-path-agy.conf`，已 `daemon-reload`
- [x] `dsh plugin --profile web add ./packages/acp-provider` → 已进 `dsh.profile.bundles`
- [~] **验收**：DSH 模型选择器出现 Antigravity 分组 —— 配置与真实链路已用临时 profile 验证通过，**Web 端需主人重启 dsh-web 后才会出现**（执行会话不重启）

### M0 验收证据

| 检查 | 结果 |
|---|---|
| `dsh --profile web --dump-config` | 含 `id: llm-antigravity-acp`，`command: /root/.local/bin/agy`，`autoPatch: false` |
| 真实对话（临时 profile `agtest`，headless） | `dsh --profile agtest "只回复一个词：pong"` → `pong`（走 agy ACP） |
| 本账号可见模型（agy 实测） | `gemini-3.8-flash`、`claude-sonnet-4-6`、`claude-opus-4-6-thinking`（`gpt-oss-120b-medium` 被插件隐藏） |
| 上下文档位 | 未解锁，256K（`/root/.gemini/antigravity/tools/agy-patch.py` 不存在，插件未做任何改写） |

> 与 PLAN 的差异：PLAN 里写的 `Gemini 4 Argon` 本账号并未下发；实际目录见上，`gemini-4-argon` 报 `UNKNOWN_MODEL`。

## M1 明细

- [x] `packages/dashboard` 骨架：Node 原生 http，systemd `antigravity-dashboard.service`，8788
- [x] 复用上游 `quota.ts` 解析逻辑，调 `agy -p /usage --output-format json`（串行化 + 3 次重试 + 60s 缓存）
- [x] 两个契约端点（外加 cost-meter 必需的 `auth-files`）
- [x] **验收**：`curl 127.0.0.1:8788/api/quota/gemini` 返回真实额度；用 cost-meter 自己的客户端代码请求 8788，status=ok，两个窗口都解析出来

### M1 验收证据

| 检查 | 结果 |
|---|---|
| `GET /api/quota/gemini` | `5h 99% · 周 99.5%`，`next_reset_5h=2026-11-08T16:58:40Z` |
| `POST /v0/management/api-call` | 信封 `status_code:200`，4 个 group（gemini-pool-weekly/5h、third-party-pool-weekly/5h），window 为 `周`/`5h` |
| `GET /v0/management/auth-files` | 单账号池，`provider:antigravity` + `project_id`（适配器硬性前置） |
| cost-meter 真实客户端 | `queryGatewayQuota` 打 8788 → `status: ok`，窗口 `重置 周日 19:58 · 周 used=0.5%`、`重置 00:58 · 5h used=1%` |
| 自动化测试 | `packages/dashboard` 17/17 通过（含「cost-meter 解析器吃得下我们的信封」回归用例） |
| 内网可达 | `http://192.168.100.6:8788/healthz` → ok |

> **与 PLAN 验收口径的偏差（需主人确认）**：PLAN 要求「数值与 8046 一致」，但 8046 读的是 CPA 账号池
> `192.168.100.4:8045/api/accounts`，其 5h 重置时间停在 `2026-10-17`（22 天前），数据已冻结：
> 8046 报 5h 已用 22.7% / 周已用 32.5%，而 agy 直读是 1% / 0.5%。两边不可能一致，**以 agy 为准**。
> 真实切换按 PLAN §四 M5 做，M1 只用 cost-meter 客户端代码做了等价性验证，没有改 ledger。

## 决策记录

1. **不自动打补丁**：上游默认 `autoPatch: true`，本项目在 profile 配置层显式关成 `false`（不改上游源码默认值）。解锁只由 M2 面板开关触发。
2. **不依赖 PATH**：`command: /root/.local/bin/agy` 写死绝对路径；PATH drop-in 仍保留，供 agy 自身派生子进程使用。
3. **构建环境**：机器上没有 DSH 源码 checkout，用 `/root/.cache/dsh-checkout` 做兼容层（symlink 到已安装的 `@deepseek-ai/dsh` 内 peer 包 + typescript + @types/node），`DSH_CHECKOUT=/root/.cache/dsh-checkout npm run build`。产物 `lib/` 与上游预编译版**字节一致**，等于零源码改动。
4. **补了 `auth-files` 端点**：PLAN §三只写了两个端点，但 cost-meter 的 cliproxyapi 源必须先
   拉 `/v0/management/auth-files` 发现账号（缺了直接 `CPA_RESPONSE_INVALID`），且 antigravity 账号
   必须有 `provider` + `project_id`。已按旧 bridge 形状补上，只读、单条「agy 本机登录」。
5. **`window` 用「周」的代价**：契约要求原样输出「周」，cost-meter 不认这个词，`periodHours` 只能是
   `null`（旧 bridge 8046 同样如此），卡片仍显示「周」，只是没有按时间推进的进度条。保持契约优先。
6. **临时验收 profile**：`/root/.dsh/profiles/agtest`（base + headless + 本插件），用于不重启 dsh-web 的前提下验证真实链路；M3 之后可复用它跑对话造数据。

## 阻塞项

（暂无）

## 最近一条日志

```
2026-11-08 21:10  M1 完成：8788 上线，两契约端点 + auth-files 通，cost-meter 客户端实测 status=ok；8046 数据确认为陈旧源
```

---

## 工作日志（新的加在最上面）

<!-- 执行会话在这里追加，每次一行：时间 + 做了什么 + 结果 -->

```
2026-11-08 21:10  M1  `packages/dashboard` 落地：agy.mjs（串行+重试+60s 缓存）/ contract.mjs（契约映射）/ server.mjs（路由）；systemd `antigravity-dashboard.service` 已 enable --now，监听 0.0.0.0:8788；17/17 测试通过
2026-11-08 21:02  M1  读 dsh-cost-meter 源码确认真实契约：cliproxyapi 源 = auth-files → api-call（信封）→ parseAntigravityQuota；`antigravityOnlyGemini` 按组名/id 过滤；percent 是「已用」方向
2026-11-08 20:58  M0-5 真实链路验收：另起 profile agtest（base+headless+插件）跑 `dsh --profile agtest "只回复一个词：pong"` → pong；catalog.json 记录 gemini-3.8-flash / claude-sonnet-4-6 / claude-opus-4-6-thinking，三档思考
2026-11-08 20:55  M0-4 向 web profile 装插件：package.json 加 link: 依赖 + bundles 追加 dsh-llm-antigravity-acp；同时追加配置层 autoPatch:false / command:/root/.local/bin/agy；dump-config 校验通过；dsh-web 未重启（PID 185125 存活，HTTP 401 正常鉴权）
2026-11-08 20:52  M0-3 新增 systemd drop-in 20-path-agy.conf（PATH 前置 /root/.local/bin），daemon-reload 后单元合并配置已含该 PATH，运行中进程保持旧环境等主人重启
2026-11-08 20:47  M0-2 构建与测试通过：npm install（9 包）→ DSH_CHECKOUT=/root/.cache/dsh-checkout npm run build → 产物 lib/ 与上游预编译版字节一致；npm test 47 pass / 0 fail（11.4s）
2026-11-08 20:45  M0-1 从上游 f049913 复制 dsh-llm-antigravity-acp 到 packages/acp-provider，本仓库 git init 并提交 ddff0cb；lib/ 预编译产物一并入库
2026-11-08 20:44  环境核查：agy 1.5.3 可用（/root/.local/bin/agy，不在 dsh-web 的 PATH 里）；dsh 0.2.2-rc.1；node 24.22.2；dsh-web 正运行（PID 185125）
2026-11-08 20:40  青梧：方案已确认，目录与 PLAN.md 就绪，等待执行会话启动
```
