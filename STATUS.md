# 进度看板

> 执行会话每完成一项就更新本文件。青梧定时读取本文件向主人汇报。
> 格式约定：`- [ ]` 未开始 / `- [~]` 进行中 / `- [x]` 已完成 / `- [!]` 阻塞

**当前阶段**：M4（面板移植）完成 → M5
**最后更新**：2026-11-08 22:25
**执行会话**：DeepSeek Harness（本会话）

---

## 状态摘要

| 阶段 | 状态 | 备注 |
|---|---|---|
| M0 基座跑通 | 4/5，验收待重启 | 插件已装进 web profile，真实对话已通 |
| M1 额度接口 | 完成 | 8788 已上线，cost-meter 客户端实测 ok |
| M2 补丁开关 | 完成 | 开关 API 就绪，真实 agy 仍锁着（等主人点开关） |
| M3 metrics 落库 | 完成 | metrics.db 有真实数据，面板只读读取无锁冲突 |
| M4 面板移植 | 完成 | 4 页面渲染真实数据，零外链 |
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

## M2 明细

- [x] 把 `agy-patch.py` 放进 `packages/dashboard/scripts/`（原样，附上游 LICENSE）
- [x] `GET /api/context-unlock/status` → `{ locked, windowTokens, ... }`
- [x] `POST /api/context-unlock` `{ enable: true|false }`
- [x] enable：`python3 agy-patch.py --binary /root/.local/bin/agy --in-place`
- [x] disable：从 `agy.bak` **原子替换**还原（`cp` 原地写会撞正在运行的进程）
- [~] 面板开关 UI 挪到 M4 设置页（API 已就绪，见「决策记录」）
- [x] **验收**：开关切换后 `--dry-run` 的 sha256 前后不同

### M2 验收证据（在 agy 副本上跑完整开关，真实二进制未动）

| 步骤 | 结果 |
|---|---|
| 初始 | `locked:true`，`windowTokens:256000`，dry-run `sha256 7ca212748ca0 -> 73e06443e3c9` |
| `enable()` | `changed:true`，`locked:false`，`windowTokens:1048576`，dry-run 变 `all gates already unlocked`，生成 `agy.bak` |
| `disable()` | `changed:true`，`locked:true`，`windowTokens:256000`，sha256 回到 `7ca212748ca0`，备份与当前二进制一致 |
| 真实 `/root/.local/bin/agy` | 未改动：无 `.bak`，dry-run 仍 `7ca212748ca0 -> 73e06443e3c9` |
| 自动化测试 | 29/29 通过（含幂等、陈旧备份拒绝、无备份拒绝、409 映射） |
| 真实服务状态 | `curl 8788/api/context-unlock/status` → `locked:true, windowTokens:256000, backup.exists:false, restartRequired:true` |

## M3 明细

- [x] 插件侧写 `metrics.db`（`~/.dsh/cache/antigravity-acp/metrics.db`）
- [x] 表结构照搬 acp2api：`sessions` / `requests`（DDL 逐字搬，含索引与 WAL）
- [x] 采集 TTFT、duration、token（input/cached/output/thought）、cache_hit_rate、status
- [x] 面板侧只读打开（`readOnly: true`），避免锁竞争
- [x] **验收**：跑几轮对话后 `requests` 表有数据，TTFT 合理

### M3 验收证据

| 检查 | 结果 |
|---|---|
| 真实对话落库 | 2 轮对话 + 1 次标题生成 → `requests` 5 行；`gemini-3.8-flash`，thinking `high`/`low`，`status:success` |
| TTFT / duration | 主请求 3444–7460ms（agy 冷启动 + 思考流），标题生成 5919ms；duration 与 TTFT 差 100–250ms |
| token 分桶 | 主请求 input 12647 / output 362 / thought 337 / total 13009（input 是未命中缓存的量，符合 acp2api 口径） |
| sessions 聚合 | `turns`、`hash_hits`、`avg_ttft_ms`、`cache_hit_rate` 同步更新；进程退出后遗留 ACTIVE 会在下次打开时置 CLOSED |
| 面板只读并发 | 边写边读 2222 轮：`readErrors: 0`，最终读出 2222 行 |
| 自动化测试 | 插件 52/52（新增 5 个 metrics 用例）、面板 32/32 |
| 面板数据面 | `GET /api/admin/overview` 一次返回 额度 + 遥测 + 解锁状态 |

> 说明：`cache_hit_rate` 目前为 0——agy 在首轮不会命中隐式缓存，且会话每轮重建；等 web 端常驻会话跑起来后才有命中样本。

## M4 明细

- [x] 搬 `dashboard-ui.ts` 的 HTML/CSS/JS（MD3 设计令牌与组件样式逐字复用）
- [x] **去掉 Google Fonts 外链**：改系统字体栈；图标字体换成内联 SVG（页面零外部请求）
- [x] 4 个页面：首页 / 请求 / 运行 / 设置
- [x] `/api/admin/overview` 读本地 metrics.db + agy 额度（一次取齐，4 页共用）
- [x] 「运行」页 worker 池改成「当前 ACP 会话数 + 模型 + 上下文窗口」
- [x] **验收**：内网 `http://192.168.100.6:8788` 打开，4 个页面都有真实数据

### M4 验收证据（无头 Chrome dump DOM，非截图）

| 页面 | 渲染到的真实内容 |
|---|---|
| 首页 | 今日请求 5 · Token 40.7k · 平均 TTFT 5.7s · 两个额度池的 5h/周环（98.8%/99.1%、98.2%/98.8%）+ 24 小时柱状图 + 最近请求 |
| 请求 | 请求/会话切换、搜索框、12 列表格（TTFT、时长、输入/缓存读/输出/思考、工具数、结束原因、状态） |
| 运行 | ACP 活会话 0 · 历史会话 5 · 上下文窗口 256.0k · agy 1.5.3 · 模型目录 3 个（含档位与请求数）+ 会话表 |
| 设置 | 解锁卡片（锁定 256K / dry-run sha256 / 备份状态）、接口清单、metrics.db 路径、主题切换 |
| 零外链 | HTML/CSS/JS 里没有 `fonts.googleapis`、CDN、`@import`；只有内联 SVG 图标 |

## 决策记录

1. **不自动打补丁**：上游默认 `autoPatch: true`，本项目在 profile 配置层显式关成 `false`（不改上游源码默认值）。解锁只由 M2 面板开关触发。
2. **不依赖 PATH**：`command: /root/.local/bin/agy` 写死绝对路径；PATH drop-in 仍保留，供 agy 自身派生子进程使用。
3. **构建环境**：机器上没有 DSH 源码 checkout，用 `/root/.cache/dsh-checkout` 做兼容层（symlink 到已安装的 `@deepseek-ai/dsh` 内 peer 包 + typescript + @types/node），`DSH_CHECKOUT=/root/.cache/dsh-checkout npm run build`。产物 `lib/` 与上游预编译版**字节一致**，等于零源码改动。
4. **补了 `auth-files` 端点**：PLAN §三只写了两个端点，但 cost-meter 的 cliproxyapi 源必须先
   拉 `/v0/management/auth-files` 发现账号（缺了直接 `CPA_RESPONSE_INVALID`），且 antigravity 账号
   必须有 `provider` + `project_id`。已按旧 bridge 形状补上，只读、单条「agy 本机登录」。
5. **`window` 用「周」的代价**：契约要求原样输出「周」，cost-meter 不认这个词，`periodHours` 只能是
   `null`（旧 bridge 8046 同样如此），卡片仍显示「周」，只是没有按时间推进的进度条。保持契约优先。
6. **M2 的 UI 挪到 M4**：M2 只交付 API + 原子还原 + 陈旧备份保护；开关按钮和「需重启 dsh-web 生效」
   的提示随 M4 设置页一起做，避免同一个页面写两遍。代价：现在只能 curl 切开关。
7. **插件 `patchScript` 指向面板里的那份脚本**：插件启动时只跑 `--dry-run` 探测，`autoPatch:false`
   保证它永不写盘；探测到 unlocked 才会声明 1,048,576。否则面板解锁后插件仍会按 256K 声明。
8. **备份不匹配就拒绝 unlock**：脚本只在 `.bak` 不存在时才建备份，agy 升级后旧 `.bak` 会被保留，
   直接还原等于把版本退回去；所以 enable 前先比对 sha256，不一致回 409 让人先处理旧备份。
9. **metrics 只写请求级、不写流式中间态**：每个 DSH model step 一行（`pump()` 插桩），
   tool-calls 步与 stop 步都记；辅助会话（标题生成、压缩摘要）同样记，因为它们真花额度。
10. **metrics 写失败只计数不抛出**：遥测坏了不能拖垮模型请求，失败数留在 `failureCount` 里。
11. **面板不用图标字体**：上游靠 Material Symbols 图标字体（外链），内网会卡住且拉不到；
    改成 18 个内联 SVG 描边图标，视觉上更统一，也彻底零外网依赖。
12. **静态资源分文件**：`/assets/app.css`、`/assets/app.js`，HTML 只做骨架；比单文件好排障。
    代价：多了两个 200KB 级的请求（内网无感）。
13. **面板不做「当前进程 PID」**：dashboard 是独立进程，看不到 dsh-web 的 ACP 会话；
    「ACP 活会话」来自插件写的 sessions 表，代表真实会话而非进程。
14. **临时验收 profile**：`/root/.dsh/profiles/agtest`（base + headless + 本插件），用于不重启 dsh-web 的前提下验证真实链路；M3 之后可复用它跑对话造数据。

## 阻塞项

（暂无）

## 最近一条日志

```
2026-11-08 22:25  M4 完成：4 个页面在内网地址上渲染真实数据，零外链，35/35 测试通过
```

---

## 工作日志（新的加在最上面）

<!-- 执行会话在这里追加，每次一行：时间 + 做了什么 + 结果 -->

```
2026-11-08 22:25  M4  面板落地：dashboard.css（上游 MD3 令牌/组件）+ dashboard.js（4 页渲染 + 5s 轮询 + 解锁开关）+ ui.mjs 骨架；用无头 Chrome `--dump-dom` 逐页核对真实数据
2026-11-08 22:15  M4  踩坑：抽 CSS 时把上游内联主题脚本一起带进了 dashboard.css（测试「零外链」先红了才发现），已裁掉并补测试兜底
2026-11-08 22:05  M3  面板侧 `src/metrics.mjs`（readOnly + 汇总 SQL）与 `/api/admin/overview`、`/api/metrics/requests` 落地；WAL 并发压测 2222 次读写 0 错误
2026-11-08 21:55  M3  插件侧 `src/metrics.ts`（照搬 acp2api schema）+ `runtime.pump()` 插桩：TTFT/时长/四类 token/tool 调用数/status 全部落库；插件测试 52/52
2026-11-08 21:35  M2  `src/patch.mjs` + 两个路由落地；串联化、幂等、陈旧备份 409、无备份 409；在 /tmp 的 agy 副本上跑通 enable→disable→状态回路，真实二进制未动
2026-11-08 21:20  M2  读上游 agy-patch.py：没有 `--restore`（PLAN §六 的回滚命令不存在），只有 `--in-place` 会建 `.bak` 且仅当 `.bak` 缺失时才建 → 决定了「陈旧备份拒绝」策略
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
