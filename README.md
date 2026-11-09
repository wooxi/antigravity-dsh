# Antigravity for DeepSeek Harness (antigravity-dsh)

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-brightgreen.svg)](https://nodejs.org/)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-%3E%3D0.2.0--rc.1-blue.svg)](https://github.com/deepseek-ai/dsh)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./packages/acp-provider/LICENSE)

将本地官方 Google Antigravity CLI 深度集成至 **DeepSeek Harness (DSH)** 的一级模型提供商（Primary Model Provider）与全栈监控管理套件。

通过原生 Agent Client Protocol 协议直连，不触碰任何网络逆向与第三方中转，兼具零封号风险、原生工具审批与子代理并发能力，并提供零外部依赖的独立现代化监控面板。

---

## 核心特性与亮点 (Key Features)

### 1. 原生一级模型 Provider，深度融入 DSH 生态
- **模型选择器原生直选**：Antigravity 模型家族与 DeepSeek、GLM 等直连供应商并列显示，无缝支持在输入区自由切换。
- **完整保留 DSH 智能体执行流**：不同于常规的 OpenAI 网关代理方案，本集成不引入冗余的外部 Agent 封装，DSH 自有的工具执行、沙箱隔离、危险操作审批确认、多智能体并发调度及子代理（Subagent）编排能力全部原生生效。
- **流式思维链与多档推理强度**：完整映射模型思考流（Reasoning Stream），支持针对模型动态配置 `Low`、`Medium`、`High` 三档思维强度。

### 2. 官方通信协议直连，安全零封号风险
- **原生协议与官方进程**：基于官方 CLI 规范通信，鉴权与登录态完全驻留于官方本地进程，无需配置任何第三方中转，杜绝账号凭据泄露风险。
- **沙箱化环境隔离**：运行于独立的隔离工作目录，彻底隔绝用户本地全局配置、非受控规则及自定义 MCP 服务的干扰，确保执行行为确定性。

### 3. 百万上下文弹性扩展，按需可逆解锁
- **默认官方基准安全运行**：默认遵循官方 256K 安全上下文窗口策略，稳定可靠。
- **按需释放百万上下文能力**：针对海量代码库重构与超长上下文推理场景，提供一键解锁机制，将上下文窗口弹性拓展至物理极限（最高 1,048,576 Tokens / ~1M），并同步解除单步输入截断限制。
- **状态可视化与安全回滚**：控制台内置双向健康探测，支持一键热切换与原子化无损还原，新版升级自动保护，拒绝版本回退风险。

### 4. 细粒度高精度遥测，全链路落库
- **毫秒级性能指标采集**：精准监控首字延迟（TTFT）、总响应耗时、生成吞吐量及每步流式健康度。
- **多维度 Token 精细化核算**：全面采集未命中缓存输入（Input Tokens）、缓存命中读写（Cache Read/Write）、模型生成（Output）以及思维推理（Thought Tokens），精准统计 Prompt 缓存命中率。
- **高并发零锁存储**：基于高性能 SQLite WAL 事务引擎，异步只读隔离，海量请求高并发记录无任何锁竞争与写入阻塞。

### 5. 纯内网极简控制台 (Modern MD3 Dashboard)
- **100% 离线运行，零外网依赖**：全站彻底剔除所有外部字体（Google Fonts）与第三方静态资源 CDN，内嵌高精度 SVG 图标，专为隔离内网、企业内网及私有私有云环境打造，秒级秒开。
- **直观四大全景视图**：
  - **总览大盘 (Home)**：实时展示 24 小时请求趋势、总吞吐指标、平均 TTFT 性能波形及双额度池（周度/5小时）环形仪表盘。
  - **流量审计 (Traffic)**：多维度会话与调用列表，提供多关键词即时检索、单步详细 Token 构成剖析与错误诊断。
  - **运行时监控 (Runtime)**：即时查看活跃会话数、官方 CLI 版本、模型目录状态以及上下文窗口规格。
  - **控制中心 (Settings)**：提供可视化的上下文解锁一键切换、备份文件健康状态检查与服务通信契约概览。

### 6. 配额双轨输出，无缝接入成本中心
- **不消耗额度的实时查询**：直接调取官方额度监控接口，刷新账号剩余用量完全不损耗任何模型 Token。
- **标准契约无缝对接**：内置输出兼容契约，开箱即可作为数据源无缝挂载至 `dsh-cost-meter` 等成本统计看板，多窗口进度条对齐展示。

---

## 模块组成

| 组件 | 路径 | 定位与运行方式 |
|---|---|---|
| **ACP Provider** | `packages/acp-provider` | DSH 官方插件，运行于 DSH 核心运行时，驱动底层模型与会话管道 |
| **Antigravity Dashboard** | `packages/dashboard` | 独立系统服务（端口 `8788`），提供 Web 控制台及额度集成 API |
| **Context Unlocker** | `packages/dashboard/scripts/agy-patch.py` | 上下文窗口弹性管理工具，由控制台按需安全调用 |

---

## 快速上手

### 环境要求
- 已安装并完成登录的官方 Antigravity CLI (`agy >= 1.5.0`)
- DeepSeek Harness (`dsh >= 0.2.0-rc.1`)
- Node.js `>= 22.19` (利用原生 `node:sqlite` 支持)

### 1. 部署 Provider 插件

```bash
cd packages/acp-provider
npm install
npm run build
dsh plugin --profile web add ./packages/acp-provider
```

在 Profile 补丁配置（例如 `cordis.patch.yml`）中挂载插件：

```yaml
- id: llm-antigravity-acp
  config:
    command: /root/.local/bin/agy
    autoPatch: false
    patchScript: /path/to/antigravity-dsh/packages/dashboard/scripts/agy-patch.py
```

### 2. 启动控制台与额度服务

控制台以独立轻量服务运行，通过 systemd 进行生命周期管理：

```bash
# 注册并启动面板服务（默认监听内网 0.0.0.0:8788）
systemctl enable --now antigravity-dashboard
```

访问控制台：`http://<SERVER_IP>:8788`。

---

## 接口契约一览

控制台服务对外暴露纯净的只读标准化接口：

- `GET /api/admin/overview`：控制台全量遥测、模型目录及配额聚合大盘
- `GET /api/quota/gemini`：标准 Gemini 原生额度快照接口
- `POST /v0/management/api-call`：适配外部成本监控面板的标准化配额信封
- `GET /v0/management/auth-files`：标准化账号发现与元数据标识
- `GET /api/context-unlock/status`：实时上下文锁定与备份健康检测
- `POST /api/context-unlock`：安全上下文弹性切换开关 (`{"enable": true|false}`)

---

## 开源许可

本项目遵循 [MIT License](./packages/acp-provider/LICENSE)。
