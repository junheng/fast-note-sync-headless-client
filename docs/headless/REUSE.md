# 稳定版复用与补丁清单

客户端来源为正式 release `2.4.0`，精确提交见 `BASELINE.json`。本表区分已抽取的共享模块与后续计划，不把计划当作已实现能力。

## 模块边界

| 链路 / 原模块 | 当前宿主依赖 | 实施方式 | 必须验证 |
| --- | --- | --- | --- |
| `src/lib/sync/websocket_action.ts`、`src/pb/protobuf_mapper.ts` 及生成的 protobuf | 消息映射依赖共享常量及生成代码 | 原样复用动作名、DTO 映射及编解码；Node 不另写协议表 | JSON/protobuf 往返、分页编号转换、未知动作、失败码 |
| `src/lib/sync/websocket_client.ts` | 原有 Vault 计数存储、WebSocket、时钟与日志 | 已抽取 `WebSocketConnectionState` / `WebSocketHost`；插件 `websocket_obsidian.ts` 与 Node `headless/connection.ts` 共用原类 | 断线、取消、背压、二进制帧、旧连接回调 |
| `src/lib/sync/websocket_manager.ts` | `FastSync`、Obsidian Platform/moment、通知、设置持久化、同步启动 | 已将认证发送与协商移至 `websocket_auth.ts`，两端共用；同步分发与 UI 仍留在插件 | 拒绝认证不启动同步；成功认证不等于同步成功 |
| `src/lib/api/http_api_service.ts` | `FastSync`、宿主请求、重定向与设置、计时器 | 复用所需下载/API 行为，只适配 HTTP I/O；管理升级等功能不暴露为客户端自动动作 | 取消、范围读取、HTTP/业务错误、重定向边界 |
| `src/lib/utils/helpers.ts` 的 `hashContent` / `hashContentAsync` / `hashArrayBuffer` / `hashFileAsync` | 异步让出依赖 window；文件哈希依赖 Vault adapter、资源 URL 和 Range fetch | 已移至无宿主依赖的 `protocol_hash.ts`，插件保持 `hashFileAsync` 包装；Node 消费同一算法 | UTF-16、emoji、10 MiB 边界、20 MiB 采样盲区、读入期间文件变化 |
| `src/lib/sync/operator.ts`、`sync_progress_tracker.ts`、`sync_state.ts` | 扫描 Vault、离线删除确认 UI、进度回调、插件状态 | 已抽取 `batch_sync.ts` 和 `sync_protocol.ts`；插件和 Node 共用库存批次、信封页号及 PageAck，Headless 单独持久化完成条件 | End 提前到达、重复/乱序页、写失败、重启不能跳过未完成项 |
| `src/lib/sync/operator_note.ts` | `TFile`、Vault、路径锁、pending、缓存、通知/冲突 UI | 已抽取 `note_protocol.ts` 的库存发送、内容落盘及 `noteModification` 请求字段，两端实际消费；Node 不可变发送/读回确认组件已通过合成故障测试，运行入口和版本化冲突决策已接入 | 同路径 A 的 Ack 不确认 B；远端落盘前复核；删除/重命名前置条件 |
| `src/lib/sync/operator_file.ts` | `TFile`、Platform、adapter 临时分片、会话、缓存与 HTTP API | 已抽取 `file_protocol.ts` 的库存发送、下载请求、`fileUploadCheck`、二进制帧编码/解码和分片组装；Node 上传从持久快照读取，中断后新建会话并完整重传；已通过原版 3.5.1/3.6.1 的 JSON/protobuf 上传及路径操作验证，完整文件调度入口已接入 | 中断、重复分片、缺片、过期会话、同采样哈希不同内容 |
| `src/lib/storage/file_hash_manager.ts`、`local_storage_manager.ts` 与镜像工具 | Obsidian 本地存储、adapter、延迟写入 | 插件保留兼容存储；Headless 事务存储实现共享窄接口，不以插件缓存作为持久化成功凭据 | 已确认基线恢复、落盘失败、崩溃恢复、身份错配 |

## 必须显式改变的策略

当前 `receiveNoteModifyAck` 按路径查找当时的 pending，不能直接证明确认的是具体发送版本。Node 使用持久化不可变版本和单操作连接确认，保留本地后继编辑，不修改插件自身的 pending 行为。笔记与附件的删除消息仅携带 Vault、路径及路径哈希；按用户要求沿用该官方语义，预读不代表原子条件删除，也不因缺少 CAS 禁止操作。附件 End 不代替 Node 分片落盘与状态提交。实际服务端特征测试说明继承限制，不将上游问题修复加入本项目范围。

`mutation_protocol.ts` 抽取官方笔记/附件删除和重命名的相同请求字段，由两个插件 operator 和 Node 上传组件共同使用；不新增服务端字段。`--headless-write` 已在原版 3.5.1 / 3.6.1 上验证两种编码的正常路径操作。

Headless 新增持久化状态机、内容版本核对及冲突契约；协议动作、编码、分片和分页实现仍来自共享模块。Node 已直接消费共享认证、传输、DTO 与 protobuf 映射；没有实现协议副本或完整的伪 Obsidian runtime。后续每次抽取须在本表补上实际文件、两端消费者和回归证据。

## 当前补丁

| 文件 | 原因与范围 | 已运行回归 |
| --- | --- | --- |
| `tests/websocket-auth-error.test.mjs` | 更新过期模块加载路径，使用实际常量/格式化/认证分发 | `test:auth`；拒绝认证不进入同步 |
| `src/lib/storage/file_hash_manager.ts`、`tests/file-mirror-restore.test.mjs` | 先加载确认基线，避免本地缓存恢复过程中用空映射覆盖基线；不改变线上协议 | `test:mirror` 原场景及独立/空基线、旧格式迁移组合 |
| `protocol_hash.ts`、`helpers.ts` | 原算法搬移，注入让出与范围读取；插件包装与 Node 文件读取共用 | `test:hash` 固定稳定版金向量、阈值、20 MiB 盲区特征及两种宿主读取 |
| `websocket_client.ts`、`websocket_auth.ts`、`websocket_obsidian.ts`、`websocket_manager.ts`、`headless/connection.ts` | 抽取宿主 I/O 和认证协商；取消隔离旧连接事件与积压发送 | `test:transport`、`test:auth`；固定服务端 JSON/protobuf 客户端信息往返、取消与独立进程退出 |
| `headless/state_records.ts`、`headless/state_store.ts` | Node 专属事务元数据存储，不复制插件协议，不改变插件缓存 | `test:state`：事务回滚、重启、强制退出、实际写入权限失败、损坏与未知版本拒绝 |
| `headless/filesystem.ts` | Linux 受限目录访问、目录 inode 所有权锁；不在插件内引入 Node 文件 API。只读查询对同目录大小写变体返回“不存在”，写入/创建/身份声明与枚举仍拒绝变体 | `test:filesystem`：真实独立进程争锁、崩溃释放、链接替换、路径/大小写保护、只读与写入的碰撞差异及写入失败；`test:sync` 的大小写重命名轮次 |
| `headless/snapshots.ts`、`file_application.ts`、`conflicts.ts` | 外置不可变版本、本地文件与状态提交恢复、最小三方冲突；继续调用共享哈希 | `test:application` 的创建/替换进程崩溃与外部修改；`test:conflicts` 的首次冲突/三方/删除/二进制/重启 |
| `batch_sync.ts`、`sync_protocol.ts`、`note_protocol.ts`、`file_protocol.ts` | 从稳定版 operator/main/manager 抽取，两端实际消费；修复即时 Ack 竞态、宿主间会话串扰和关闭后残留 timer | `test:pull` 与固定服务端 JSON/protobuf 笔记/附件接收探针，插件 build/lint 和继承测试 |
| `headless/collection_pull.ts`、`note_pull.ts`、`file_pull.ts`、`download_chunks.ts` | Node 完成与资源策略；共享分页状态机，分片全到齐且内容校验/落盘完成后才推进页；拒绝只读上传请求 | 乱序/重复/缺片、内容改变、End 提前、应用失败、取消、完整 SHA-256、跨进程中断恢复 |
| `headless/download_batch.ts`、`durable_note_pull.ts`、`durable_file_pull.ts` | 事务批次/会话落盘；重启从零请求远端清单，不采用未完成检查点 | SQLite 提交失败、End 不提交、强制终止后的全量重读、幂等重复与本地冲突保留 |

完整插件回归见 `VALIDATION.md`。目前 Node 的认证身份、完整清单、发送/读回与文件落盘已由 `remote.ts` / `reconcile.ts` / `runtime.ts` 接入独立 CLI。本地完整内容扫描与周期核对见 `headless/scanner.ts` / `test:scan`；双向发送确认与通用同步 CLI 已接入，冲突决策通过同一所有者互斥和官方上传/读回路径应用。

`content_routes.ts` 从官方 `HttpApiService.getNoteList/getFileList` 抽取相同查询字段，插件和 Node 的只读身份/回收站查询共用。回收站总行数为零时接受服务端原有的 `list: null`；不新增 REST 写路径。`--reconcile` 与 `--rename-sync` 在原版 3.5.1/3.6.1 验证真实响应、两客户端双向、重命名与 CLI 进程。

`headless/resolution.ts` 仅负责通用决策、版本复核、持久恢复和受控查询；不新增协议动作，不修改上游冲突 UI。决策本地应用复用 `LocalRequests`，远端确认复用 `DurableOutbox` / `uploadOperation`，普通请求恢复跳过尚待重新验证的决策意图。`test:conflicts` 覆盖独立 Bot 进程和七个 SIGKILL 边界。

## 两端消费者与回归覆盖

每个共享模块都要同时被插件和 Node 消费，并有可重复的回归入口；新增抽取点必须补齐本表。

| 共享模块 | 插件消费者 | Node 消费者 | 回归证据 |
| --- | --- | --- | --- |
| `src/lib/utils/protocol_hash.ts` | `helpers.ts` 的哈希包装 | `headless/scanner.ts`、`snapshots.ts`、`file_pull.ts`、`upload.ts` | `test:hash`、`test:scan`、`test:pull`、`test:sync` |
| `src/lib/sync/websocket_action.ts`、`types.ts`、`src/pb/protobuf_mapper.ts` | `websocket_manager.ts`、`websocket_client.ts` | `headless/connection.ts`、`upload.ts`、`pull_collection.ts` | `test:transport`、`test:auth`、固定服务端 JSON/protobuf 探针 |
| `src/lib/sync/websocket_client.ts`、`websocket_auth.ts` | `websocket_obsidian.ts`、`websocket_manager.ts` | `headless/connection.ts` | `test:transport`、`test:auth` |
| `src/lib/sync/content_routes.ts` | `http_api_service.ts` 的列表/回收站查询 | `headless/remote.ts` | `test:pull`、`--note-pull` / `--file-pull` 探针 |
| `src/lib/sync/mutation_protocol.ts` | `operator_note.ts`、`operator_file.ts` | `headless/upload.ts` | `test:sync`、`--headless-write` / `--rename-sync` 探针 |
| `src/lib/sync/batch_sync.ts`、`sync_protocol.ts` | `operator.ts` | `headless/pull_collection.ts`、`download_batch.ts` | `test:pull`、`test:sync` |
| `src/lib/sync/note_protocol.ts` | `operator_note.ts` | `headless/note_pull.ts`、`initial_notes.ts`、`file_application.ts`、`upload.ts` | `test:pull`、`test:application`、`test:sync` |
| `src/lib/sync/file_protocol.ts` | `operator_file.ts` | `headless/file_pull.ts`、`download_chunks.ts`、`upload.ts` | `test:pull`、`test:sync` |
| `src/lib/sync/folder_protocol.ts` | `operator.ts` 的目录扫描/批次发送 | `headless/folder_pull.ts`、`collection_pull.ts`、`remote.ts`、`reconcile.ts` | `test:sync` 目录用例、`--folder-sync` / `--rename-sync` 探针 |
| `src/lib/storage/file_hash_manager.ts` | 插件基线缓存与镜像恢复 | 无（Node 使用事务基线） | `test:mirror` |

`headless/` 其余文件是 Node 专属宿主、持久化、恢复与入口实现，不复制协议实现：`filesystem.ts`、`state_store.ts`、`state_records.ts`、`snapshots.ts`、`file_application.ts`、`outbox.ts`、`upload.ts`、`remote.ts`、`reconcile.ts`、`resolution.ts`、`control.ts`、`local_requests.ts`、`local_runtime.ts`、`scanner.ts`、`runtime.ts`、`sync_validation.ts`、`limits.ts`。它们由 `test:all`（`test:state/filesystem/application/conflicts/local/scan/cli/pull/sync/resources`）与固定服务端探针覆盖，逐项结果见 `VALIDATION.md`。

## 证据边界

- Project / Worktree：当前仓库、`headless/stable-2.4.0`，使用本工作区独立 `.codegraph/` 索引。
- Evidence：CodeGraph 当前源码与调用关系，必要的直接源码片段、稳定版差异及继承测试。
- Limit：静态调用图不能证明服务器条件写能力，也不能证明真实 Obsidian/Hermes 集成；原测试未覆盖的协议行为仍需新增合成测试。
- Next：升级上游正式 release 时按 `UPSTREAM.md` 的合并检查清单重跑 `test:all`、插件 build/lint 与固定服务端探针，并在本表更新实际文件、两端消费者和回归证据。
