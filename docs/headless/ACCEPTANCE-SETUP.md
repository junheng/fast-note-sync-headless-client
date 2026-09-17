# 隔离验收环境准备

目标服务器只运行 Node.js 客户端，**不安装、不启动 Obsidian**。笔记与附件只读接收器已在独立 Node 进程、固定服务端 3.6.1 上验证；双向客户端、身份绑定及 Hermes 业务验收仍在实施。

无需外部令牌即可在 Linux / WSL 运行合成接收验证（固定 Node 24.14.0，安装项目依赖并准备文档指定的 Podman 镜像）：

```sh
node scripts/probe-server-capabilities.mjs --note-pull
node scripts/probe-server-capabilities.mjs --file-pull
```

脚本创建仓库外临时目录和自己拥有的服务端，启动实际 Node 接收器，检查完整字节、持久化批次、冲突和杀进程恢复，最后清理。没有 Obsidian 或图形桌面依赖。两个命令是隔离验收入口，尚不是面向任意远端的双向同步命令；详见 `SERVER-CAPABILITIES.md`。

以下桌面环境仅用于未来与原插件互操作的兼容性验收，不是服务器运行前提。此前启动的测试 Obsidian 已正常关闭，不要求再次启动才能推进 Node 开发。

## 当前执行范围

用户于 2026-09-17 明确：本轮在本机完成客户端实现与测试，其他 agent 负责部署；不要求用户新增服务、配置反向代理或启动 Obsidian。用户随后授权直接接入现有知识库，并愿提供服务 token。首次实际接入先检查连接，再以只读方式读取到仓库外独立目录；不要把当前接收器描述成完整双向客户端。部署侧稳定身份等契约保留在交接待办，未验证的旧状态仍不得恢复。

## 直接消费现有 JSON 凭据

支持用户明确提供的 JSON 文件，字段为 `api`、`apiToken`、`vault`。按用户后续要求，本机副本统一放在仓库内已忽略的 `.local/fns.secrets.json`，权限 `0600`；程序消费时不打印内容、不提交 Git。容器使用方式见 [DOCKER.md](DOCKER.md)。运行命令中的文件路径不是令牌：

```sh
env -u BW_SESSION node scripts/check-acceptance-connection.mjs \
  --credentials-json .local/fns.secrets.json
env -u BW_SESSION node scripts/pull-acceptance-vault.mjs \
  --credentials-json .local/fns.secrets.json
```

第二个命令是本机验收的一次性只读复制：核对版本、认证主体和指定 Vault 的读取权限，每次在 `~/.local/share/fns-headless-acceptance/runs/<runId>/` 创建新的 0700 目录。笔记/附件位于 `vault/`，外置快照和批次记录位于 `state/`，结果为 `receipt.json`。不读取旧状态、不支持续跑、不上传本地清单或执行业务写入；历史删除项仅在所有者确认本地路径不存在时作为无操作项完成，存在同名内容仍停止复核；成功时也只报告 `initial-readonly-copy` / `read-complete`，不是完整双向同步。失败时保留已取得内容并返回非零，不能将部分复制当作完整结果。

用户现有服务版本为 3.5.1。已经用固定镜像在本地验证它的笔记/附件链路，并单独验证上述验收入口；当前入口只接受已测试的 3.5.1 / 3.6.1。3.5.1 在插件令牌下查询 `/api/vault` 返回 314，`/api/notes`、`/api/files` 可读。本次新目录读取以用户指定的 Vault 名称和当前认证读取权限为范围，没有伪造不可获得的稳定服务/Vault 身份；结果不得用于自动恢复旧 pending。完整可恢复同步仍需完成身份绑定任务。

只读复制沿用单笔记 20 MiB、单附件 32 MiB 上限，每种集合累计接收最多 256 MiB；超限停止并保留部分结果。不会为完成一次复制悄悄放宽客户端的资源边界。

## 历史准备与可选 env-file 接入

Linux 验收根目录为 `~/.local/share/fns-headless-acceptance`，已验证不在 Git 仓库中；目录权限 `0700`，包含 `node-vault`、`node-state`、`obsidian-vault` 和 `receipts`。本次实际 Windows Obsidian 使用 Windows 原生目录 `%LOCALAPPDATA%\fns-headless-acceptance\vault`，其独立全局配置为同根 `profile`，避免通过 WSL 共享路径承载 Obsidian 文件监听。Linux 下预留的 `obsidian-vault` 当前未使用。

由用户在本机终端执行：

```sh
cd ~/.local/share/fns-headless-acceptance
cp -n credentials.env.example credentials.env
chmod 600 credentials.env
```

用本机编辑器填写 `credentials.env` 中的 `FNS_ENDPOINT`、`FNS_TOKEN` 和 `FNS_VAULT`。本轮也可按用户授权填写现有知识库及其令牌；真实笔记仅保存在仓库外，不进入合成测试或普通输出。令牌或文件内容不发到对话。完成后回复“已配置”。Agent 不读取、显示或 source 该文件，由客户端通过 Node 的 `--env-file` 直接消费。空白 `credentials.env` 已以 0600 创建，直接编辑即可，无需覆盖现有文件。

配置后，在本项目目录、固定 Node 24.14.0 下执行连接检查：

```sh
env -u BW_SESSION node \
  --env-file="$HOME/.local/share/fns-headless-acceptance/credentials.env" \
  scripts/check-acceptance-connection.mjs
```

该脚本只认证，不开始同步或写业务文件；输出脱敏状态，将回执保存到验收根目录的 `receipts/connection.json`。认证成功仍显示 `synchronization: "not-run"`。后续需验证服务端能力与身份、接入共享同步链路，再运行真实插件/Node 双向用例，不能把连接检查当作任务 8.2 完成。

## 真实插件环境和回执

`scripts/prepare-obsidian-acceptance.mjs <Windows 根目录的 WSL 路径>` 只接受全新、名为 `fns-headless-acceptance` 的绝对目录，将当前 `main.js`、manifest 和 CSS 安装到专用 Vault；初始化时同步关闭、日志关闭、配置同步关闭。不能将已有用户 Vault 作为目标。辅助验收插件只在已验证的测试 Vault/profile 中记录宿主加载结果，不实现任何同步协议。

实际实例以 `--user-data-dir=<专用 profile>` 启动。首次加载须为这个 Vault 启用社区插件；本次使用仅绑定回环的 `19227` 调试端口，`scripts/verify-obsidian-host.ps1 -ExpectedProcessId <本次启动 PID>` 同时检查端口进程归属与运行时 Vault/profile 身份后才启用。脚本仅适用于当前准备流程，不使用默认实例的 CLI、URI 或调试端口。

验收后正常关闭本次创建的 Obsidian 实例，保留目录。Linux 验收根的 `receipts/plugin-host.json` 保存脱敏加载结果，`receipts/build.json` 保存插件 bundle SHA-256 和上游精确提交；本次没有服务端双向或 Hermes 成功回执。历史运行数据和 Vault 位于仓库外；按用户后续要求，凭据副本和新 Docker 本地测试目录使用仓库内被忽略的 `.local/`。两类位置均不提交 Git，文档只记录脱敏结果。
