# antigravity-dsh

把本机官方 Antigravity CLI（`agy`）接成 DSH 一级模型，并提供一个独立的监控面板服务。

- 详细方案：[PLAN.md](./PLAN.md)
- 进度看板：[STATUS.md](./STATUS.md)

## 两个组件

| 目录 | 是什么 | 跑在哪 |
|---|---|---|
| `packages/acp-provider` | DSH 插件，`agy acp` 原生协议 provider | 由 dsh web 加载 |
| `packages/dashboard` | 独立 HTTP 服务，面板 + 额度接口 | systemd，端口 8788，仅内网 |

## 为什么不用 agy-acp2api 接 DSH

agp2api 是「把 agy 当模型」的 OpenAI 网关，DSH 接进去会变成 agent 套 agent，丢掉 DSH 自己的工具审批、子代理并发、思考流映射。

这里用原生 ACP provider，工具仍由 DSH 执行，agy 只负责生成。

## 它解决了什么

1. **封号风险**：走 `agy acp` 官方协议，登录态留在官方进程，不碰 OAuth 逆向、不做账号池轮换
2. **上下文**：前端开关触发 `agy-patch.py`，256K → 983K，可随时关闭还原
3. **额度可见**：面板直接展示 `agy -p /usage` 的真实账号额度
4. **喂给 cost-meter**：暴露两个与旧 bridge 完全兼容的端点，`dsh-cost-meter` 只改 `baseURL`

## 端口

| 端口 | 用途 |
|---|---|
| 8788 | 面板 + cost-meter 接口（本服务） |
| 8046 | 旧 bridge，保留不动 |

## 快速验证

```sh
# 额度
curl -s http://127.0.0.1:8788/api/quota/gemini | jq

# 面板
open http://192.168.100.6:8788
```
