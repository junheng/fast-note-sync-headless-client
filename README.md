# Fast Note Sync Headless Client

面向服务器、容器和 Agent 的 Fast Note Sync 双向同步客户端，基于 [官方 Obsidian 插件](https://github.com/haierkeys/obsidian-fast-note-sync)维护 fork。

**当前状态：独立 Node 双向文件同步和常驻入口已接通，完整 MVP 仍在验收与完善。** `once`、`daemon` 支持持久状态恢复；笔记和附件已在固定原版服务端验证双向收敛。通用冲突决策已接通；完整目录操作、资源验收和 Hermes 业务验收尚未完成。Docker 默认运行 `daemon`，配置方式见 [Docker 交付说明](docs/headless/DOCKER.md)。历史只读镜像不能替代新的双向构建。原项目说明保存在 [README.upstream.md](README.upstream.md)。

## 目标

- 在没有 Obsidian / Electron / 浏览器窗口的 Node.js 环境中常驻运行。
- 本地笔记目录与 Fast Note Sync 服务端双向同步，复用官方协议和同步逻辑。
- 正确处理笔记、附件、目录、修改、删除、重命名及离线恢复。
- 持久化同步基线、待确认操作和冲突记录；进程重启不会丢失工作。
- 将无法安全自动合并的冲突交给外部解决者。Hermes 集成指定“智库馆长”为负责人。
- 定期合并官方更新，经兼容性测试后发布固定版本。

## 接手入口

1. [AGENTS.md](AGENTS.md)：项目边界与开发约束。
2. [实现交接方案](docs/headless/HANDOFF.md)：已知事实、架构、分阶段任务及验收标准。
3. [上游维护方案](docs/headless/UPSTREAM.md)：fork 基线、合并方式与发布门禁。

当前实施清单见 [OpenSpec tasks](openspec/changes/add-headless-integration-mvp/tasks.md)，实际验证与已知阻塞见 [VALIDATION.md](docs/headless/VALIDATION.md)。冲突调用方式见 [控制契约](docs/headless/CONTROL.md)。后续推进目录操作、资源限制与完整集成验收。

## 模块方向

```text
Obsidian 插件 ──┐
               ├── 共享同步核心 ── Fast Note Sync 服务端
Node.js 入口 ───┘
    ├── 本地文件与状态存储适配器
    ├── 服务生命周期与健康状态
    └── 冲突接口 ── 外部解决者（Hermes：智库馆长）
```

先保持上游源码结构，验证最小复用边界，再做必要重构。避免维护完整 Obsidian 模拟层，也不从第三方 CLI 重新实现一套协议。

## 开发与来源

运行时、包管理器版本以 `.node-version`、`package.json` 的 `engines` 和 `packageManager` 为准。`pnpm run build` 构建原插件，`pnpm run build:headless` 构建独立入口 `dist/headless/cli.cjs`。容器构建与运行契约见 Docker 说明；镜像按源码提交构建；Unix 控制入口支持查询最后确认检查点。

保留上游 Git 历史、作者信息和 LICENSE。本仓库不是 Obsidian 公司官方客户端。上游 LICENSE 与 package 元数据存在差异，发布前需完成来源核对，详见上游维护方案。
