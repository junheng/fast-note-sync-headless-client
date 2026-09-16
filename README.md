# Fast Note Sync Headless Client

面向服务器、容器和 Agent 的 Fast Note Sync 双向同步客户端，基于 [官方 Obsidian 插件](https://github.com/haierkeys/obsidian-fast-note-sync)维护 fork。

**当前状态：项目定位与实现交接已建立，Headless 服务尚未实现。** 仓库中的现有源码、构建脚本和发布配置主要来自原插件；现有 `main.js` 入口不是可运行的 Headless 客户端。原项目说明保存在 [README.upstream.md](README.upstream.md)。

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

建议给下一位 Agent 的任务：

> 阅读 AGENTS.md 与 docs/headless/HANDOFF.md，先完成阶段 0 和阶段 1：建立上游测试基线，抽出最小宿主接口，并使用合成笔记在隔离目录验证无 Obsidian 运行时的只读同步。记录实际命令与结果；不要接入生产 Vault。完成后按交接方案逐阶段推进双向同步、冲突处理和常驻服务。

## 设计方向（待实现）

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

运行时、包管理器版本以 `.node-version`、`package.json` 的 `engines` 和 `packageManager` 为准。现有测试与构建命令及其局限见交接方案；服务命令、Docker 镜像与健康端点尚不存在。

保留上游 Git 历史、作者信息和 LICENSE。本仓库不是 Obsidian 公司官方客户端。上游 LICENSE 与 package 元数据存在差异，发布前需完成来源核对，详见上游维护方案。
