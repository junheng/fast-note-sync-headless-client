# Docker 交付与运行

当前可交付的是**一次性只读拉取预览版**：无需 Obsidian，可将指定上游 Vault 的笔记和附件下载到指定宿主机目录。镜像内只有独立 Node 入口和运行依赖，启动时不编译、不安装 npm 包，也不加载测试代码。

尚不支持双向写入、常驻同步或恢复已有状态；这次 Docker 交付不代表完整 MVP 已验收。目标笔记目录和状态目录都必须为空，使用方需确保运行期间没有其他程序修改它们。退出后可以使用已下载文件；失败时保留部分内容和状态，不自动清空或覆盖旧目录。

## 构建与 Compose

在仓库根目录执行：

```sh
docker build -t fast-note-sync-headless-client:local \
  --build-arg VCS_REF="$(git rev-parse HEAD)" .
mkdir -p .local
cp -n compose.env.example .local/compose.env
```

编辑 `.local/compose.env`：填写上游 URL、远端 Vault 名称、两处宿主机绝对目录、令牌文件绝对路径及运行用户 UID/GID。令牌文件只存 token，权限设为 `0600`，并让指定 UID 可读。笔记和状态目录需提前创建、对该 UID 可写；状态目录权限必须为 `0700`，且位于笔记目录之外。Linux 本地文件系统为当前支持范围，不使用 NFS、SMB 或 Windows 共享目录。

```sh
docker compose --env-file .local/compose.env run --rm fns-headless
```

Compose 将笔记目录挂载为 `/vault`、状态目录挂载为 `/state`，以 secret 文件传入 token。采用非 root UID、只读容器根文件系统，默认 512 MiB 内存、2 CPU、64 个进程上限，不发布网络端口，不自动重启。

## 使用现有 JSON 凭据

JSON 字段为 `api`、`apiToken`、`vault`。本仓库的本机测试副本位于已忽略的 `.local/fns.secrets.json`。下面直接消费该文件；每次测试选择一组新的空目录：

```sh
mkdir -m 700 .local/docker-vault .local/docker-state
docker run --rm --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --memory=512m --cpus=2 --pids-limit=64 \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD/.local/docker-vault,dst=/vault" \
  --mount "type=bind,src=$PWD/.local/docker-state,dst=/state" \
  --mount "type=bind,src=$PWD/.local/fns.secrets.json,dst=/run/secrets/fns.json,readonly" \
  -e FNS_CREDENTIALS_FILE=/run/secrets/fns.json \
  -e FNS_LOCAL_WRITER_MODE=exclusive \
  fast-note-sync-headless-client:local
```

命令默认执行 `pull`。JSON 模式与分开配置 `FNS_ENDPOINT/FNS_VAULT/FNS_TOKEN_FILE` 二选一，避免不明确的配置覆盖。修改上游时更新 JSON 中的 `api` 或使用 Compose 的 `FNS_ENDPOINT`；修改同步目标时更新宿主机挂载路径。

## 配置与结果

| 配置 | 含义 |
| --- | --- |
| `FNS_ENDPOINT` | 现有同步服务 URL，支持 HTTP/HTTPS；不包含令牌、query 或 fragment |
| `FNS_VAULT` | 远端知识库名称 |
| `FNS_TOKEN_FILE` | 容器内仅包含 token 的文件路径 |
| `FNS_CREDENTIALS_FILE` | 可替代以上三项的 JSON 文件路径 |
| `FNS_VAULT_DIR` | 容器内笔记目录，默认 `/vault` |
| `FNS_STATE_DIR` | 容器内独立状态目录，默认 `/state` |
| `FNS_LOCAL_WRITER_MODE` | 必须明确设为 `exclusive`；使用方保证本地排他写入 |

退出码 `0` 表示本轮笔记与附件批次均提交，且已应用文件的完整摘要复核通过。标准输出和 `/state/receipt.json` 的结果为 `scope: initial-readonly-copy`、`status: read-complete`，不表示双向同步成功。退出码 `2` 表示配置、校验、冲突、取消或运行失败；在状态目录准入前的失败只输出回执，不修改已有状态文件。

再次使用非空目录会返回 `initial-copy-requires-empty-directories`；保留原数据，选择新的空目录重试。不得删除状态后把旧文件当成可恢复基线。`SIGTERM`/`SIGINT` 取消在途接收并保留未完成状态；不会将残缺附件发布为完整文件。

已测试上游版本为 `3.5.1`、`3.6.1`。当前每种集合最多接收 256 MiB，笔记/附件单项上限为 20/32 MiB，每种集合传输最多 5 分钟。超限、哈希不匹配均返回失败；真实库中已有一例附件元数据哈希不一致，另有附件总量超限，详见 [验证记录](VALIDATION.md)。容器没有绕过这些约束。

## 交付给使用方

本次交付 `Dockerfile`、`compose.yaml`、`compose.env.example`、本说明和精确源码提交；使用方可从固定提交构建镜像，也可使用 Gitea 自动构建的预览镜像。后续正式发布需补齐双向/恢复验收，再交付独立 Headless 版本号、兼容矩阵与回滚说明。Hermes Ops 负责部署、凭据挂载、权限和生产切换，本仓库负责客户端及其运行契约。

### Gitea 自动构建

构建仓库为 [diomgis/fast-note-sync-headless-client](https://g1t.sigmoid.cc:53691/diomgis/fast-note-sync-headless-client)，本地 remote 名称为 `gitea`。推送 `headless/stable-2.4.0` 分支触发 `.gitea/workflows/build-image.yaml`：

```sh
git push origin headless/stable-2.4.0
git push gitea headless/stable-2.4.0
```

流水线使用本仓库专属的 `mac-mini-fns-headless` runner（标签 `personal-build`），复用 Mac mini 上现有的 Colima Docker，读取账号级 `REGISTRY_USERNAME`、`REGISTRY_PASSWORD` secrets 和 `BUILD_PROXY_URL`、`BUILD_NO_PROXY` variables。开发机的 `.local/gitea.env` 只用于仓库管理与推送，不进入镜像或工作流。CI 使用临时 Docker 认证目录并在退出时清理。

runner 由构建机的 `cc.sigmoid.gitea-runner-fns-headless` LaunchDaemon 管理，以 `automation` 用户运行；配置与注册文件位于该用户的 `.config/gitea-runner-fns-headless/`，工作目录位于 `.cache/gitea-runner-fns-headless/`。注册范围限定本仓库，容量为 1，标签为 `personal-build:host`，复用已有 runner 二进制。原有其他仓库的 runner 注册范围不变。迁移构建机时需在本仓库 Actions 设置重新注册 runner，不能仅依赖其他仓库同名标签。

runner 进程的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 由 LaunchDaemon 配置，用于下载远端 action；其值在配置时取自上述账号构建变量。容器构建代理则由工作流每次读取变量并写入临时 Docker 配置。代理变更后，运维需同步 runner 的进程环境并重载其服务。

当前发布架构为 **linux/arm64**。每次构建发布 `g1t.sigmoid.cc:53691/diomgis/fast-note-sync-headless-client:sha-<完整提交 SHA>`，随后按摘要拉取，检查架构和源码 revision，并在只读、非 root 容器内运行 CLI 帮助。成功日志提供 `Image: ...@sha256:...`；使用方应固定该摘要，不将可重新推送的标签当作不可变版本。该检查验证镜像交付，不替代同步协议验收。

使用已发布镜像时，先通过 `docker login g1t.sigmoid.cc:53691` 使用自己的只读镜像凭据登录，将成功流水线输出的完整镜像摘要写入 `.local/compose.env` 的 `FNS_IMAGE`，再执行：

```sh
docker compose --env-file .local/compose.env pull fns-headless
docker compose --env-file .local/compose.env run --rm --no-build fns-headless
```

其余上游、目标目录和令牌文件配置与前文相同。AMD64 使用方目前需从 Dockerfile 本地构建；不能把 ARM64 镜像当作已验证的原生 AMD64 交付物。

`.dockerignore` 只允许构建输入进入上下文，`.local/`、`.env`、Git 历史、测试数据和笔记不会进入镜像。Node 基础镜像固定为 24.14.0 及多架构索引摘要（自动选择 AMD64/ARM64 子镜像），pnpm 固定为 11.1.2，依赖使用冻结锁文件。构建同时复制上游已有的 `pnpm-workspace.yaml` 安装脚本许可配置，不依赖开发机的全局设置；配置方式见 [pnpm 11 说明](https://github.com/pnpm/pnpm.io/blob/main/blog/releases/11.0.md)。

## 可重复验证

本机使用 rootless Podman 构建同一 Dockerfile；以下探针自行启动、清理固定摘要的临时服务端，不读取真实凭据：

```sh
podman build -t localhost/fast-note-sync-headless-client:local .
node scripts/probe-server-capabilities.mjs --container-pull --server-version=3.5.1
node scripts/probe-server-capabilities.mjs --container-pull
```

验证非 root 用户、只读根文件系统、可配置上游/挂载目录、笔记/附件完整字节、持久化回执、缺少写入约定零副作用、非空目录重复启动拒绝和输出隐私。该验证与完整双向及 Hermes 业务验收分开记录。
