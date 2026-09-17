# 本机验收环境准备

服务器只运行 Node.js 或本项目容器，不依赖 Obsidian。当前已提供 `once`/`daemon` 双向文件同步、身份绑定、持久恢复和通用冲突决策。目录操作与实际 Obsidian 互操作仍在验收；Hermes 业务回执由 Ops 提供。当前支持范围以 [DOCKER.md](DOCKER.md)、[VALIDATION.md](VALIDATION.md) 和 OpenSpec 任务为准。

## 合成测试

使用固定 Node 24.14.0 / pnpm 11.1.2，安装冻结依赖，并准备 Podman。固定服务端镜像摘要见 [SERVER-CAPABILITIES.md](SERVER-CAPABILITIES.md)。

```sh
pnpm run build
pnpm run build:headless
pnpm run test:sync
pnpm run test:conflicts
pnpm run test:resources
node scripts/probe-server-capabilities.mjs --reconcile
node scripts/probe-server-capabilities.mjs --reconcile --server-version=3.5.1
node scripts/probe-server-capabilities.mjs --rename-sync
podman build -t localhost/fast-note-sync-headless-client:local .
node scripts/probe-server-capabilities.mjs --container-sync
```

探针自行启动本机临时固定服务，使用合成账户、独立 Vault 和状态目录，不读取真实凭据或笔记。新服务配置和双向测试目录位于忽略的 `.local/`，正常结束后清理。它们不是部署动作，不要求用户新增服务或配置反向代理。`--note-pull`/`--file-pull` 保留为只读接收、分页和恢复专项入口。

## 本机凭据与运行目录

用户授权的 JSON 凭据副本统一放在仓库内已忽略的 `.local/fns.secrets.json`，权限 `0600`；字段为 `api`、`apiToken`、`vault`。由程序直接消费，不显示、source 或提交。新本机运行目录也放在 `.local/`，例如分别挂载 `.local/client-vault`、`.local/client-state`。实际 Docker/Compose 配置见 [DOCKER.md](DOCKER.md)。

`once` 和 `daemon` 会向远端写入，运行前应明确选择测试 Vault 与受控目录、配置写入方式。`pull` 仅作初次只读复制，必须使用全新空目录；其成功不是双向验收。已有状态绑定端点、认证主体、Vault 名称及本地目录身份；同主体令牌轮换可恢复，已知身份错配保留原状态并拒绝重放。服务独立身份无法验证时如实记录，不要求新增响应头。

历史开发脚本 `check-acceptance-connection.mjs` 和 `pull-acceptance-vault.mjs` 使用旧的仓库外验收根目录。它们不是当前交付入口；新测试使用上述 `.local/` 和容器/CLI 显式目录，不继续分散复制凭据。

## 实际插件互操作测试

Obsidian 只作为桌面测试对端，不是 headless 运行依赖。历史准备了 Windows 原生独立目录 `%LOCALAPPDATA%\fns-headless-acceptance\vault` 及同根 `profile`，专用测试实例已关闭；不要使用用户日常 Vault 或默认实例。

`scripts/prepare-obsidian-acceptance.mjs <Windows 根目录的 WSL 路径>` 只接受全新、名为 `fns-headless-acceptance` 的绝对目录，安装当前插件产物；初始化时同步、日志和配置同步关闭。辅助插件只记录宿主加载，不实现协议。实际实例使用专用 `--user-data-dir`；`scripts/verify-obsidian-host.ps1 -ExpectedProcessId <本次启动 PID>` 校验回环调试端口进程归属以及运行时 Vault/profile 身份后，才能启用测试插件。

旧的 `~/.local/share/fns-headless-acceptance/receipts/plugin-host.json` 与 `build.json` 仅证明宿主加载及构建版本，不是双向成功回执。实际插件互操作与外部 Hermes 业务验收分别记录，不能由两个 Node 实例或测试 resolver 代替。Ops 步骤及所需回执见 [HERMES-ACCEPTANCE.md](HERMES-ACCEPTANCE.md)。
