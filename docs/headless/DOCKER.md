# Docker 交付与运行

当前源码提供独立 Node 双向文件同步：`once` 执行一轮，`daemon` 常驻核对，重启使用同一份持久状态继续。Docker 默认运行 `daemon`，不依赖 Obsidian。笔记及附件的双向修改、离线删除、受控重命名和冲突保留已接入；通用冲突决策入口已接入，完整目录操作和资源验收尚待完成，因此尚未宣称完整 MVP 验收通过。

历史发布的只读预览镜像不会自动获得这些功能。使用本次源码构建，或固定后续成功流水线发布的源码 revision 和镜像摘要；不要继续使用旧只读摘要来验收双向。

## 构建和启动

```sh
docker build -t fast-note-sync-headless-client:local .
mkdir -p .local
cp -n compose.env.example .local/compose.env
```

编辑 `.local/compose.env`，配置上游、远端 Vault、宿主机笔记及状态目录、token 文件路径、UID/GID。token 文件只存令牌，权限 `0600`；状态目录权限 `0700`。目录需提前创建，对容器 UID 可读写，且位于 Linux 本地文件系统。状态目录必须在笔记目录之外。运行中保留笔记目录和状态目录的路径及 inode。

首次接入可以有本地内容；同路径内容不同时保留双方，记录冲突。旧 `pull` 预览状态没有身份绑定，不能直接升级复用；保留旧数据，另建状态和验收目录，验证后由 Ops 安排切换。禁止删除状态后把旧文件当作已确认基线。

```sh
# 执行一轮；仅完整收敛返回 0
docker compose --env-file .local/compose.env run --rm fns-headless once
# 常驻运行，同一组挂载目录可停止后恢复
docker compose --env-file .local/compose.env up -d fns-headless
# 通过运行中所有者查询上次确认检查点
docker compose --env-file .local/compose.env exec fns-headless node /app/cli.cjs status
```

Compose 使用非 root 用户、只读容器根文件系统、512 MiB 内存、2 CPU、64 个进程上限，不发布网络端口。当前不自动重启；常驻运行会对连续失败进行最多 8 次有界尝试，间隔退避至最多 60 秒，状态损坏和已知身份错配立即失败。`SIGINT`/`SIGTERM` 取消在途传输，完成已接受的本地修改后释放目录所有权；未确认操作保留供下次重试。

## 配置

| 配置 | 含义 |
| --- | --- |
| `FNS_ENDPOINT` | HTTP/HTTPS 上游地址，不含账号、query 或 fragment |
| `FNS_VAULT` | 远端 Vault 名称 |
| `FNS_TOKEN_FILE` | 仅含 token 的文件路径，Compose 挂载到 `/run/secrets/fns_token` |
| `FNS_CREDENTIALS_FILE` | 替代以上三项的 JSON 文件，字段 `api`、`apiToken`、`vault`；两种配置二选一 |
| `FNS_VAULT_DIR` / `FNS_STATE_DIR` | 容器内目录，默认 `/vault` / `/state`；宿主机路径通过挂载配置 |
| `FNS_LOCAL_WRITER_MODE` | 必须明确为 `controlled` 或 `exclusive` |
| `FNS_SYNC_INTERVAL_MS` | 轮次之间的等待，默认 5000，范围 1000–3600000 毫秒 |
| `FNS_PROTOBUF` | 默认 `true`，可设为 `false` 使用 JSON |

`controlled`：外部写入者通过运行中所有者的 `local-write` 入口提交带预期版本的请求。Ops 必须限制 Bot 直接写入笔记目录；配置名称本身不构成权限隔离。`exclusive`：使用方保证只有客户端能写目标目录。两个模式都禁止以不同状态目录启动第二个同步写入者。

本机已有 JSON 凭据可只读挂载到 `/run/secrets/fns.json`，设置 `FNS_CREDENTIALS_FILE=/run/secrets/fns.json`；不要同时配置单独的 endpoint/vault/token。凭据不应放进命令参数、镜像或 Git。

## 结果和受控写入

`once` 退出码：`0` 表示该轮笔记和附件观察版本收敛、不可变上传版本已确认、最后本地扫描与检查点在同一互斥范围完成；`2` 表示冲突、未完成或错误；`130` 表示取消。输出为 JSON，包含 `status`、`pending`、`conflicts`、`historyUnverified`、`lastSuccess` 和本轮上传/下载数。`scope: bidirectional-files` 不包括空目录、Obsidian 配置或延期的采样盲区专项审计。

`status` 只读查询不会启动一次网络同步，`lastSuccess` 只表示上次完成时间，不承诺查询时本地和远端仍相同。普通输出不包含凭据、笔记路径或内容。状态目录中 `control.sock` 为 `0600` Unix socket，客户端通过目录描述符寻址，较长的项目目录也可使用。

`local-write` 从标准输入读取 JSON 请求，再交给运行中所有者；不要自行写 SQLite。请求字段、冲突查询、版本快照和馆长决策例子见 [控制契约](CONTROL.md)。返回 `applied` 仅表示本地修改持久化，`synchronization: not-confirmed`，要等待后续同步确认。幂等 ID 相同但载荷不同会拒绝。

保留的 `pull` 命令仍只向全新空目录做一次只读复制，输出 `scope: initial-readonly-copy`，不支持恢复。它不是新的默认模式。

## 当前边界

已验证原版服务端 3.5.1、3.6.1，沿用官方稳定插件 2.4.0 的消息、编码、分页和分片。删除/重命名不因缺少原子 CAS 而禁用，但继承官方竞争窗口；身份核对覆盖端点、认证 UID、Vault 名称及本地目录，无法保证识别所有同址后端替换。不修改上游服务。

单项笔记/附件上限 20/32 MiB；整库笔记与附件累计上限 1 GiB、含父目录最多 1 万项；本地完整扫描使用相同上限。每个集合最多 5 分钟；一次只执行一个上传。当前完整清单和每次上传读回复用官方下载链路，开销随库大小增加，尚未做增量性能优化。接收队列最多 1 万条/64 MiB 文本；元数据最多 5 万条/64 MiB，上传历史最多 1 万条。不可变快照默认合计 4 GiB、最多 5 万个文件，可用 `FNS_SNAPSHOT_QUOTA_BYTES` 调整字节配额（1 字节至 16 GiB）；启动会计入崩溃遗留的临时快照，内容相同的快照复用不重复计费。当前不自动回收历史快照，配额不足返回 `snapshot-limit`，需保留状态并由使用方增加配额和可用空间。超限、正文哈希不匹配、无可靠删除历史均不会报告同步完成。真实库已观察到的哈希不一致及容量限制见 [验证记录](VALIDATION.md)。

冲突保留三方快照并阻止相关路径自动覆盖；馆长通过 `resolve` 提交带预期版本的决策，查询、分块内容及幂等状态见 [CONTROL.md](CONTROL.md)。Hermes Ops 负责部署、权限、备份、Bot 接入和生产切换，本仓库不代替其业务验收。

### Gitea 自动构建

构建仓库为 [diomgis/fast-note-sync-headless-client](https://g1t.sigmoid.cc:53691/diomgis/fast-note-sync-headless-client)，本地 remote 名称为 `gitea`。推送 `headless/stable-2.4.0` 分支触发 `.gitea/workflows/build-image.yaml`：

```sh
git push origin headless/stable-2.4.0
git push gitea headless/stable-2.4.0
```

流水线使用本仓库专属的 `mac-mini-fns-headless` runner（标签 `personal-build`），复用 Mac mini 上现有的 Colima Docker，读取账号级 `REGISTRY_USERNAME`、`REGISTRY_PASSWORD` secrets 和 `BUILD_PROXY_URL`、`BUILD_NO_PROXY` variables。开发机的 `.local/gitea.env` 只用于仓库管理与推送，不进入镜像或工作流。CI 使用临时 Docker 认证目录并在退出时清理。

runner 由构建机的 `cc.sigmoid.gitea-runner-fns-headless` LaunchDaemon 管理，以 `automation` 用户运行；配置与注册文件位于该用户的 `.config/gitea-runner-fns-headless/`，工作目录位于 `.cache/gitea-runner-fns-headless/`。注册范围限定本仓库，容量为 1，标签为 `personal-build:host`，复用已有 runner 二进制。原有其他仓库的 runner 注册范围不变。迁移构建机时需在本仓库 Actions 设置重新注册 runner，不能仅依赖其他仓库同名标签。

runner 进程的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 由 LaunchDaemon 配置，用于下载远端 action；其值在配置时取自上述账号构建变量。容器构建代理则由工作流每次读取变量并写入临时 Docker 配置。代理变更后，运维需同步 runner 的进程环境并重载其服务。

当前发布架构为 **linux/arm64**。每次构建发布 `g1t.sigmoid.cc:53691/diomgis/fast-note-sync-headless-client:sha-<完整提交 SHA>`，随后按摘要拉取，检查架构和源码 revision，并在只读、非 root 容器内运行 CLI 帮助。成功日志提供 `Image: ...@sha256:...`；其中用户名可能被 Gitea 的 secret 脱敏替换为 `***`，此时须恢复为上面的完整仓库路径。使用方应固定该摘要，不将可重新推送的标签当作不可变版本。该检查验证镜像交付，不替代同步协议验收。

使用已发布镜像时，先通过 `docker login g1t.sigmoid.cc:53691` 使用自己的只读镜像凭据登录，将成功流水线输出的完整镜像摘要写入 `.local/compose.env` 的 `FNS_IMAGE`，再执行：

```sh
docker compose --env-file .local/compose.env pull fns-headless
docker compose --env-file .local/compose.env run --rm --no-build fns-headless
```

其余上游、目标目录和令牌文件配置与前文相同。AMD64 使用方目前需从 Dockerfile 本地构建；不能把 ARM64 镜像当作已验证的原生 AMD64 交付物。

`.dockerignore` 只允许构建输入进入上下文，`.local/`、`.env`、Git 历史、测试数据和笔记不会进入镜像。Node 基础镜像固定为 24.14.0 及多架构索引摘要（自动选择 AMD64/ARM64 子镜像），pnpm 固定为 11.1.2，依赖使用冻结锁文件。构建同时复制上游已有的 `pnpm-workspace.yaml` 安装脚本许可配置，不依赖开发机的全局设置；配置方式见 [pnpm 11 说明](https://github.com/pnpm/pnpm.io/blob/main/blog/releases/11.0.md)。

## 可重复验证

探针只消费自行启动的固定摘要临时服务和合成凭据，临时文件集中在本仓库忽略的 `.local/`，结束后清理。

```sh
pnpm run test:sync
node scripts/probe-server-capabilities.mjs --reconcile
node scripts/probe-server-capabilities.mjs --reconcile --server-version=3.5.1
podman build -t localhost/fast-note-sync-headless-client:local .
node scripts/probe-server-capabilities.mjs --container-sync
```

`--reconcile` 验证双向笔记、9 MiB 附件、重启后的离线删除、幂等空同步，以及独立 CLI 进程的常驻运行、受控写入、重复启动保护、停止恢复和普通输出隐私。`--container-sync` 追加同一个 Dockerfile 的非 root 容器双向上传/下载和持久状态重启检查。它们不替代实际 Obsidian 与 Hermes 的业务回执。
