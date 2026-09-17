# 固定服务端能力验证

## 版本与证据范围

2026-09-16 使用官方正式 release [3.6.1](https://github.com/haierkeys/fast-note-sync-service/releases/tag/3.6.1)，tag 解析为 `7a6c78792c631f999c8a5f725bba5dd7235d6688`。镜像固定为：

```text
docker.io/haierkeys/fast-note-sync-service@sha256:15833f15e83cee05794c3fe6028c7e41fd36c787f0d651415cad556579fc379f
```

镜像标签报告版本 `3.6.1`、revision `7a6c787`，运行中 `/api/health` 返回版本 `3.6.1` 及数据库已连接。此证据只覆盖本页探测，不能当作完整兼容性声明。

探测采用 rootless Podman、512 MiB 内存上限、2 CPU、随机本地回环端口、全新临时状态。合成账户和令牌仅留在进程/临时实例中；最终移除实例、卷和临时配置。未读取现有 `.env` 或生产 Vault，未修改或发布服务端。

## 可重复的附件探测

运行环境为项目固定的 Node.js `v24.14.0` / pnpm `11.1.2`，冻结安装依赖后执行：

```sh
podman pull docker.io/haierkeys/fast-note-sync-service@sha256:15833f15e83cee05794c3fe6028c7e41fd36c787f0d651415cad556579fc379f
node scripts/probe-server-capabilities.mjs
```

脚本只创建自己拥有的临时实例，不接受外部服务地址或凭据。复用稳定版 `helpers.ts` 的实际哈希函数、`websocket_action.ts`、`types.ts` 的常量以及实际 `WebSocketClient`，VM 替身只提供测试所需宿主依赖。这是能力探针，不是 Headless runtime，也不替代真实 Obsidian 验收。

固定合成向量：20 MiB 全零附件，在偏移 6 MiB 处把一个字节改为 1，大小不变。用 REST 播种初始文件，再按插件实际 WebSocket 上传检查路径请求更新。初始播种返回的协议哈希也与客户端计算结果一致。

| 用例 | 实测结果 |
| --- | --- |
| 两份附件的协议采样哈希 | 相同 |
| 两份附件的完整 SHA-256 | 不同 |
| 保留 mtime 的 `FileUploadCheck` | code `6`，未返回 `FileUpload`，未创建可供客户端上传的会话 |
| 增加 mtime 的 `FileUploadCheck` | code `6`，仍未返回 `FileUpload` |
| 每次检查后的完整下载 | 长度均为 20 MiB，完整摘要仍匹配初始内容，不匹配修改后内容 |
| REST 直接上传修改内容的对照 | 保留原 mtime 也能存储，并完整读回修改内容；没有证明原子条件写或不可变版本读取 |

固定配置显式启用 `app.is-return-sussess: true`，以便观察 code `6`。默认关闭时，本次探测只收到认证成功，等待上传检查响应超时；固定源码 `pkg/app/websocket.go:634` 的 `ToResponse` 确认无动作名、无 data/details 的此类成功响应可以被省略。不能把无响应当作成功。

依据：固定提交的 `internal/service/file_service.go:194` 在内容哈希相同分支直接返回无需更新；`internal/routers/websocket_router/ws_file.go:131` 只对 Create / UpdateContent 分支建立上传会话。REST 对照走不同入口，不足以证明插件上传链路可收敛。

## 共享 Node 连接验证

```sh
node scripts/probe-server-capabilities.mjs --connection-only
```

此模式使用实际 `src/headless/connection.ts` 的 Node bundle，没有加载 Obsidian runtime；仍只操作脚本创建的全新隔离服务端。已验证 JSON/protobuf 认证协商及实际 ClientInfo 编解码往返、错误凭据拒绝、认证前/中/后取消，以及独立进程成功退出 0、拒绝认证退出 2。普通输出不含合成令牌。连接成功明确报告 `synchronizationStarted: false`，没有进入业务同步。

## 笔记写入前置条件实测

```sh
node scripts/probe-server-capabilities.mjs --write-preconditions
```

同样只使用脚本创建的全新隔离服务端。此探针用共享 Node 连接、动作常量、哈希和编解码发送有界合成操作，在一次决策所依据的读取之后插入新的已确认修改，再执行旧决策。JSON 与 protobuf 两组结果一致：

| 场景 | 实际结果 | 能证明的边界 |
| --- | --- | --- |
| `manualMerge` 下旧 `baseHash` 再修改 | code `530`，保留服务端新内容 | 该顺序下能检测冲突；未证明服务端检查与提交间的原子性，也未证明弱哈希碰撞保护 |
| 读取版本 A 后，修改 B 得到 Ack，再按 A 的决策删除 | `NoteDeleteAck` code `1`，普通读取返回 `430` | 删除了已更新的笔记；请求只有路径等字段，没有预期版本条件 |
| 检查目标不存在后，目标被创建，再重命名 | code `431`，来源与目标均保留 | 已占用目标检查有效；此错误信封没有 context，不能按并发请求精确归属 |
| 来源读取为 A 后被改成 B，再重命名到空目标 | `NoteRenameAck` code `1`，新路径内容为 B，旧路径读取返回 `430` | 来源没有预期版本保护；不是把 A 的决策拒绝为陈旧决策 |

固定源码依据：`internal/dto/note_dto.go` 的 `NoteDeleteRequest` / `NoteRenameRequest` 没有预期内容版本；`internal/service/note_service.go` 的 `Delete` 按路径读取后标记删除，`Rename` 先检查目标占用再读取/移动来源；`ws_note.go` 保留 `manualMerge` 冲突分支。服务端软删除/历史可能保留恢复资料，本探针没有声称物理擦除；但普通同步视图中的新版本已被旧删除意图移除。

这些是上游行为证据。用户于 2026-09-17 再次明确基于官方插件实现、不修复其问题；原“缺少原子前置条件则 blocked-capability”的交付门禁已取消。客户端复用官方删除/重命名请求，保留持久化意图和已发现的冲突，按实际确认及读回提交基线；检查后的并发窗口仍存在，不宣称已经修复。目录/删除历史等尚未覆盖的矩阵继续补齐。

## 独立 Node 的只读接收（2026-09-17）

```sh
node scripts/probe-server-capabilities.mjs --note-pull
node scripts/probe-server-capabilities.mjs --file-pull
```

每个模式均启动自己拥有的全新服务端，配置每页 2 项；每次接收由独立 Node 子进程执行，设置空 DISPLAY/WAYLAND_DISPLAY，并断言 bundle 没有插件 main、operator 或 Obsidian runtime。这两个模式不加载早期能力探针的 VM 宿主替身来执行接收器，也不接受用户端点或令牌。

| 范围 | JSON 与 protobuf 的实际结果 |
| --- | --- |
| 笔记 | 7 篇、4 页；中文、emoji、CRLF、BOM、空内容、嵌套目录完整 SHA-256 一致 |
| 附件 | 3 个、2 页；5 字节二进制、空文件、12 MiB + 1 字节附件完整 SHA-256 一致 |
| 重复接收 | 全量重读结果一致；没有新增本地文件应用记录 |
| 已有本地修改 | 保留本地完整内容和远端快照，生成缺少共同基线的冲突；批次不提交 |
| 笔记进程恢复 | 文件已落盘、第一页提交之前 SIGKILL；新 Node 进程全量重读，最终仅 7 项文件应用 |
| 附件进程恢复 | 首个分片持久化后 SIGKILL；未发布部分附件，新进程丢弃旧临时分片并申请新会话，最终 3 项文件应用 |
| 文件发布后应用记录未提交 | 笔记/附件均经实际 SIGKILL 验证；重新下载完整版本后复用匹配应用，最终无 prepared 遗留，无重复应用记录 |
| 只读发送记录 | 仅 ClientInfo、NoteSync/FileSync、PageAck、FileChunkDownload；无业务上传、远端删除、重命名 |

附件合成清单（完整字节摘要）：

| 字节数 | SHA-256 |
| --- | --- |
| 5 | `6171db06a1c89b1ff8ab77e479d5df976ccd88a7b63567b4b18f413649e12ff3` |
| 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| 12582913 | `bbb0dd29864914386a250545019d5044075fcc93c668e7d224fa1ccc7231e4d0` |

附件通过共享 WebSocket 传输、原插件的 FileUploadCheck/分片帧创建测试数据，收到 FileUploadAck 后再读文件信息核对。服务端 REST 上传入口直接计算全字节滚动哈希，插件超过 10 MiB 后使用采样哈希；本次非零大附件用 REST 播种时两者不同，因此不能用该路径初始化插件兼容夹具。本次未修改任一上游哈希算法，也未引入运行时 REST 上传绕行。

`test:pull` 另外覆盖提前 End、延迟/失败的持久化回调、乱序页、重复项、FileUpload/NeedPush 只读拦截，以及附件乱序/重复/缺失/损坏分片、会话串扰、版本变化、磁盘写失败、空附件和中断临时文件回收。网络读取完成后仍需批次事务提交成功才返回接收成功。

当前接收资源上限为单笔记 20 MiB、单附件 32 MiB、分片 8 MiB、单个活动下载、排队二进制 64 MiB、一次接收最多 10000 项/页和 50000 分片，每种集合的累计内容最多 256 MiB。超限会阻塞而非跳过；这不是全部状态/快照空间配额与峰值内存验收。重启采用完整重拉，不跨连接复用远端下载会话，也不声称具备按分片续传能力。

这些结果证明隔离目标的接收组件，尚未接入任意服务端身份绑定、已确认三方基线和双向 CLI，不代表完整 Vault 或 Hermes 验收。接收回执的 scope 仅为 notes 或 files。

## 现有服务 3.5.1 的兼容验证

用户授权接入的现有服务报告版本 3.5.1。新增同版本本地验证，不升级现有服务，也不改变客户端 2.4.0 稳定基线。镜像标签 revision 为 `b6b4566`，运行时 health 与固定镜像版本均为 3.5.1：

```text
docker.io/haierkeys/fast-note-sync-service@sha256:9d20a69e22d266fd02c0723d0fde2db29e83c11cbb950251c248f31a191a4e1b
```

```sh
node scripts/probe-server-capabilities.mjs --server-version=3.5.1 --note-pull
node scripts/probe-server-capabilities.mjs --server-version=3.5.1 --file-pull
```

两条命令均通过 JSON/protobuf、分页、完整字节、重复读取、本地冲突、分片/页面/应用提交边界的进程强制终止恢复。笔记模式还调用实际 `pull-acceptance-vault.mjs --credentials-json`，验证新的仓库外目录、7 篇笔记/0 个附件及完整字节。额外播种并删除一篇笔记和一个附件，验证服务端返回历史删除时，仅在本地确认不存在后完成页项，不执行文件删除；然后清理自身合成结果。

实际用户服务的只读能力查询确认认证成功、`/api/user/info` 可读；插件令牌下 `/api/vault` 返回业务码 314，笔记与附件列表返回 1。这些结果只用于范围识别，不公开账户、Vault 名称、服务地址或正文，也不表示稳定服务身份及旧状态恢复已经得到验证。一次性新目录复制与可恢复双向同步严格区分，见 `ACCEPTANCE-SETUP.md`。

## 身份查询与轮换探针

```sh
node scripts/probe-server-capabilities.mjs --identity-only
```

2026-09-17 实际取得同主体两份手动令牌的查询结果并比较，仅输出字段名和布尔结论，不输出令牌或用户资料。用户 API 含 `uid`，Vault 列表含 `id/vault/createdAt`；换令牌后 UID 和 Vault 元数据不变，凭据本身及其摘要不应进入持久化绑定。health 字段为 `database/status/uptime/version`，未提供已验证的稳定服务身份。相同版本可以运行在不同后端，相同服务也可以升级版本，因此版本核对不能替代服务身份核对。

按用户最新边界，独立服务身份不是上游改造要求或启动门禁。客户端以实际可取得的端点、认证主体、Vault 名称及本地目录作绑定，服务/Vault 独立标识不可取得时明确为空。认证失败与已知错配仍拒绝恢复；报告不承诺识别同地址、同主体标识和同名 Vault 背后的后端替换。旧探针的 `recoveryGate` 字段属于历史策略，不能继续作为当前部署要求。

## 能力矩阵（尚未完成）

| 能力 | 源码证据 | 运行证据 / 未知项 |
| --- | --- | --- |
| 认证 | WebGUI 注册后签发受客户端范围约束的手动令牌；WebSocket Authorization | 真实 Node 连接的 JSON/protobuf 认证及 ClientInfo 往返通过；错误令牌、认证前/中/后取消、子进程成功 0 / 失败 2 已验证；同主体换令牌后的 UID 和 Vault 元数据一致 |
| 笔记修改 / Ack | `ws_note.go` 有 baseHash/manualMerge 分支；Ack 带路径与时间，信封可带 context | 两种编码均实测修改 Ack 携带 context，manualMerge 旧基线返回 530；检查/提交的原子性与完整版本关联仍未验证 |
| 附件上传 | `FileUploadCheck` / 上传会话 / `FileUploadAck` | 合成夹具的正常 WS 分片上传及 Ack 已实际执行；同哈希异内容不进入上传，可靠上传重试和 Ack 丢失仍未验证 |
| 完整附件下载 | REST 可读取完整字节；ETag 使用数据库中的协议 contentHash | 独立 Node WS 分片与完整字节、重启重拉已通过；并发时服务端不可变版本保证仍未知 |
| 删除 | `FileDeleteRequest` 只有 Vault、路径、路径哈希、context；`fileService.Delete` 读取后直接标记删除 | 笔记已实测旧删除意图可删除其后已确认的新编辑；附件/目录竞态尚未验证，不能把客户端预读当作条件删除 |
| 重命名 | 笔记目标占用检查及已删除记录复用分支 | 已占用目标 code 431 且无 context；来源更新后仍可重命名，来源/目标原子保护未证明；跨目录与大小写重命名已实际收敛，见下节 |
| 分页、批次与 End | DTO 和路由存在 batch/page/Ack 支持 | 笔记 4 页/附件 2 页真实接收通过；提前 End、重复/乱序及持久化失败有故障注入覆盖，目录批次仍未知 |
| 目录（FolderSync） | `operator_folder.ts` 的接收处理器与 `operator.ts` 的目录扫描/批次发送 | `--folder-sync` 在 3.6.1 与 3.5.1 通过：一端创建 `empty-folder/nested` 后另一端收到空目录，删除后另一端移除；声明同轮发出，服务端不回推声明方自己的目录；`FolderSyncRename` 与目录删除通知沿用官方语义 |
| 删除历史 | 参考配置软删除保留为 90 天 | 离线删除已按回收站历史证据传播并实测（`--rename-sync` 的离线删除与重启用例）；缺失记录按“不删除”处理已有合成覆盖；90 天保留期到期本身无法在探针内等待，保留未知项 |
| 主体 / Vault / 服务身份 | 用户响应有 UID，Vault 列表有 ID，版本接口有软件版本 | 同主体换令牌稳定性已验证；服务身份、重建 Vault 和服务升级恢复仍未证明，版本号不是服务身份 |

该矩阵是任务 1.6 的交付物：固定服务端版本、操作/Ack/分页/删除历史/条件写均给出源码或运行证据，并显式列出未知项（来源原子性、同哈希异内容、历史保留期到期、目录批次、独立服务身份）。未测试项不得从源码推定为支持，矩阵不构成完整兼容声明。

## 当前决策：接受上游限制并继续实施

用户于 2026-09-16 明确决定“我们先不管 等上游自己修复”。大附件采样盲区作为首版已知上游限制，不再阻塞整个 apply 或声明范围内的首版交付；本仓库不实施专项插件/服务端修复、REST 绕行或强制上传方案，也不另建兼容修复 change。

上述实测证据继续有效：原样复用稳定版 WS 上传不能保证采样盲区修改收敛，REST 对照也没有证明并发条件写。首版文档和验收必须披露这一限制，不能标记为已修复或已通过。不因本次例外扩大到其他并发保护、身份校验、操作确认或持久化要求。

原专项任务 3.5（静默变化周期审计）、5.5（同哈希异内容上传/确认）、8.6（三端盲区验收）移入 OpenSpec 延后清单，不计入当前任务完成率，不勾选为完成。保留本探针，待上游正式稳定版包含相关修复时复核；没有承诺上游修复时间，也没有安装后台跟踪任务。

正常版本核对已经发现的差异、pending 和冲突仍须如实保留；不能为解除项目级阻塞而误报某次已知失败操作成功。一般附件同步、只读链路、宿主抽取及其他首版任务继续实施。

真实 Obsidian 三端采样盲区验收留待上游修复；Hermes 业务回执仍是独立的必需验收。本探针成功退出仅表示行为被复现，**不表示 Headless 首版已实现或双向功能验收通过**。

## 2026-09-17：官方协议下的 Headless 发送验证

`node scripts/probe-server-capabilities.mjs --headless-write` 及附加 `--server-version=3.5.1` 均退出 0。两种固定原版服务镜像分别验证 JSON/protobuf × 笔记/附件的创建、修改、跨目录重命名、删除、完整内容读回与状态重开。调用实际 `uploadOperation`、不可变 outbox 和共享协议实现，不使用虚构 CAS 能力，不修改官方服务端。

该结果证明发送组件和原版服务互通；不等于完整双向调度、常驻入口或 Hermes 业务验收完成。已知并发限制仍如本页记录。

## 2026-09-17：重命名与大小写路径矩阵

```sh
node scripts/probe-server-capabilities.mjs --rename-sync
node scripts/probe-server-capabilities.mjs --rename-sync --server-version=3.5.1
```

两种固定原版镜像均退出 0。探针自己创建临时实例和合成账户，不接收外部端点或凭据，除既有双向修改、离线删除、重启与幂等空同步外，新增跨目录重命名和**大小写重命名**：一端把 `nested/renamed.{md,bin}` 改为 `nested/Renamed.{md,bin}` 后，另一端在同一路径组内先落地来源删除、再创建目标，随后稳定轮次不再产生变化，旧名称经完整版本读回确认不存在。

该端点行为与源码一致：官方重命名消息仍是“来源删除 + 目标创建”两条路径变化，服务端不提供来源版本的原子条件。客户端据此按路径版本复核，并拒绝把大小写变体在本地当作可同时存在的两个名称。本探针不覆盖目录（`FolderSync*`）消息、空目录传播和目录重命名，这些仍未实现；也不证明来源/目标原子保护。
