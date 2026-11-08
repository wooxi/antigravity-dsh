# antigravity-dsh

把本机官方 Antigravity CLI（`agy`）接成 DSH 一级模型，并提供一个独立的监控面板服务。
方案与取舍见 [PLAN.md](./PLAN.md)，执行进度见 [STATUS.md](./STATUS.md)。

## 架构

```
┌──────────────────────────────────────────────┐
│  dsh web :3080/8443                          │
│  └─ packages/acp-provider（DSH 插件）          │
│       ├─ agy acp 原生 ACP v1（provider）       │
│       ├─ 工具/审批/子代理/用量 全走 DSH         │
│       └─ 写 metrics.db                        │
└──────────────────────────────────────────────┘
                     │ 单向只读（WAL, readOnly）
                     ▼
┌──────────────────────────────────────────────┐
│  packages/dashboard :8788（独立 systemd 服务） │
│  ├─ 面板 UI：首页 / 请求 / 运行 / 设置           │
│  ├─ GET  /api/quota/gemini        ← cost 用   │
│  ├─ POST /v0/management/api-call  ← cost 用   │
│  ├─ GET  /v0/management/auth-files ← cost 用  │
│  ├─ 直调 agy -p /usage 拿账号额度               │
│  ├─ 读 metrics.db 出图表（只读）                │
│  └─ POST /api/context-unlock 补丁开关          │
└──────────────────────────────────────────────┘
```

- **登录态留在官方进程**：不碰 OAuth 逆向、不做账号池轮换，降低封号风险。
- **不自动改二进制**：插件 `autoPatch: false`，解锁只由面板上的开关触发。
- **两条路并行**：旧 bridge `:8046` 原样保留，cost-meter 只改 `baseURL` 即可切回。

## 目录

| 目录 | 是什么 |
|---|---|
| `packages/acp-provider` | DSH 插件（fork 自 `lili-luo/dsh-plugin-bundle@f049913`），在插件里额外写了 `metrics.db` |
| `packages/dashboard` | 独立面板 + 额度契约服务，systemd `antigravity-dashboard.service` |
| `packages/dashboard/scripts/agy-patch.py` | 上游上下文解锁脚本（面板开关调用，插件只做 dry-run 探测） |

## 前置条件

- `agy >= 1.5.0` 且已在本机登录过一次：`/root/.local/bin/agy --version`
- DSH `>= 0.2.0-rc.1`：`dsh --version`
- Node `>= 22.19`（用 `node:sqlite`）

## 部署

### 1. 插件

```sh
cd /dsh-workspace/feishu/antigravity-dsh/packages/acp-provider
npm install
DSH_CHECKOUT=/root/.cache/dsh-checkout npm run build   # 见「构建环境」
dsh plugin --profile web add /dsh-workspace/feishu/antigravity-dsh/packages/acp-provider
```

插件配置写在 `/root/.dsh/profiles/web/cordis.patch.yml` 末尾：

```yaml
- id: llm-antigravity-acp
  config:
    command: /root/.local/bin/agy
    autoPatch: false
    patchScript: /dsh-workspace/feishu/antigravity-dsh/packages/dashboard/scripts/agy-patch.py
```

- `autoPatch: false` — 插件永不写 `agy` 二进制，只在启动时跑一次 `--dry-run` 探测。
- `patchScript` — 探测用；探测到 unlocked 才会声明 1,048,576，否则按 256,000。

### 2. PATH（systemd drop-in）

`/etc/systemd/system/dsh-web.service.d/20-path-agy.conf`：

```ini
[Service]
Environment=PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin
```

改完 `systemctl daemon-reload`；**重启 dsh-web 由主人决定**（重启后模型选择器才会出现 Antigravity 分组）。

### 3. 面板服务

```sh
systemctl daemon-reload
systemctl enable --now antigravity-dashboard
```

单元文件 `/etc/systemd/system/antigravity-dashboard.service`：Node 原生 http，监听 `0.0.0.0:8788`，
`HOME=/root`（agy 登录态）、`DASHBOARD_TZ=Asia/Shanghai`、`AGY_BINARY=/root/.local/bin/agy`。

## 验证

```sh
# 额度契约
curl -s http://127.0.0.1:8788/api/quota/gemini | jq
curl -s -X POST http://127.0.0.1:8788/v0/management/api-call | jq -r .body | jq
curl -s http://127.0.0.1:8788/v0/management/auth-files | jq

# 解锁状态
curl -s http://127.0.0.1:8788/api/context-unlock/status | jq '{locked,windowTokens,version,backup}'

# 面板数据面
curl -s http://127.0.0.1:8788/api/admin/overview | jq '{totals:.metrics.totals,sessions:.metrics.sessions,quota:.quota.status}'
```

面板：`http://192.168.100.6:8788`（仅内网）。

## 切换到新额度源（cost-meter）

`dsh-cost-meter` 的 gatewayQuotas 源 `antigravity` 目前指向旧 bridge `:8046`。切换只改 `baseURL`
（`antigravityOnlyGemini: true` 保留）：

1. dsh 设置页 → 模型/成本 → 网关额度源（Gateway Quotas）→ `Gemini Pro`
2. `baseURL` 改成 `http://127.0.0.1:8788` → 保存
3. 等 5 分钟（`refreshMinutes: 5`），侧栏「Gemini Pro」卡片应显示 5h/周 两个窗口

> 不建议手改 `/root/.dsh/storages/cost-meter/ledger.json`：该文件由插件按版本/事务写入，
> 运行中的 dsh-web 持有内存态，手改会被合并逻辑判为外部变更或直接覆盖。
>
> 两边数值不会一致：旧 bridge 读 CPA 账号池（`192.168.100.4:8045`），其 5h 重置时间已冻在
> 2026-10-17；新服务读 `agy -p /usage` 的真实账号额度。**以 agy 为准**。

## 上下文解锁（256K → 1M）

面板「设置」页 → 「解锁到 1M」。背后流程：

1. `GET /api/context-unlock/status` 跑 `agy-patch.py --dry-run`（只读，约 1.2s）
2. `POST /api/context-unlock {"enable":true}` → `--in-place`，首次会生成 `/root/.local/bin/agy.bak`
3. 解锁/还原后 **需要重启 dsh-web**，插件才会重新探测并声明 1,048,576

安全约束：

- 备份与当前二进制不一致（agy 升级过）时 **拒绝解锁**，返回 409，先人工移走旧 `agy.bak`
- 还原走「复制到临时文件 + rename」原子替换，不做原地写（避免 ETXTBSY）
- 已解锁/已锁定时开关是幂等的

## 构建环境

机器上没有 DSH 源码 checkout，`scripts/build.mjs` 通过 `DSH_CHECKOUT` 找 peer 包。
`/root/.cache/dsh-checkout` 是兼容层（symlink 到已安装的 `@deepseek-ai/dsh` 内 peer 包 + typescript + @types/node）：

```sh
DSH_CHECKOUT=/root/.cache/dsh-checkout npm run build
```

产物 `lib/` 与上游预编译版字节一致（`git diff` 干净），等于零源码改动。

## 测试

```sh
cd packages/acp-provider && npm test    # 52 个（含 metrics）
cd packages/dashboard   && npm test     # 35 个（含 cost-meter 解析器回归）
```

## 回滚

```sh
# 1. cost-meter 改回旧源：baseURL → http://127.0.0.1:8046（设置页，或恢复 ledger 备份）
# 2. 补丁还原：面板「还原官方 256K」，或
cp -p /root/.local/bin/agy.bak /root/.local/bin/agy && systemctl restart dsh-web   # 重启由主人执行
# 3. 插件卸载（下次 dsh-web 重启后消失）
dsh plugin --profile web remove dsh-llm-antigravity-acp
# 4. 面板下线
systemctl disable --now antigravity-dashboard
```

旧 bridge `:8046` 全程未改动，`systemctl status antigravity-bridge` 仍是 active。

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| 模型选择器没有 Antigravity 分组 | dsh-web 还没重启；先 `dsh --profile web --dump-config \| grep llm-antigravity-acp` 确认已挂载 |
| 报 `the Antigravity CLI (agy) was not found` | 用绝对路径 `command: /root/.local/bin/agy`；或检查 drop-in 里的 PATH |
| 报 `UNKNOWN_MODEL` | 本账号没有该模型，看 `/root/.dsh/cache/antigravity-acp/catalog.json` 的实际目录 |
| 解锁后仍是 256K | 没重启 dsh-web；或面板状态仍是 `locked`（看 dry-run 输出） |
| 面板「请求」页空 | 插件还没写过 metrics.db：跑一轮对话后看 `/root/.dsh/cache/antigravity-acp/metrics.db` |
| cost-meter 卡片报错 | 先 `curl 127.0.0.1:8788/v0/management/auth-files`，返回体必须有 `files[].provider` 与 `project_id` |
| `agy /usage` 失败 | 与 `agy acp` 争抢同一登录态：服务已串行化 + 3 次重试 + 60s 缓存；仍失败看 `journalctl -u antigravity-dashboard` |
