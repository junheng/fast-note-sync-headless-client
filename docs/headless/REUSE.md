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
| `src/lib/sync/operator_note.ts` | `TFile`、Vault、路径锁、pending、缓存、通知/冲突 UI | 已抽取 `note_protocol.ts` 的库存发送和内容落盘宿主接口，两端实际消费；笔记发送确认及冲突决策仍待实现 | 同路径 A 的 Ack 不确认 B；远端落盘前复核；删除/重命名前置条件 |
| `src/lib/sync/operator_file.ts` | `TFile`、Platform、adapter 临时分片、会话、缓存与 HTTP API | 已抽取 `file_protocol.ts` 的库存发送、下载请求、二进制帧编码/解码和分片组装；Node 分片位于状态目录，使用共享范围读取适配；持久化上传状态机仍待实现 | 中断、重复分片、缺片、过期会话、同采样哈希不同内容 |
| `src/lib/storage/file_hash_manager.ts`、`local_storage_manager.ts` 与镜像工具 | Obsidian 本地存储、adapter、延迟写入 | 插件保留兼容存储；Headless 事务存储实现共享窄接口，不以插件缓存作为持久化成功凭据 | 已确认基线恢复、落盘失败、崩溃恢复、身份错配 |

## 必须显式改变的策略

当前 `receiveNoteModifyAck` 按路径查找当时的 pending，不能直接证明确认的是具体发送版本。笔记与附件的删除消息仅携带 Vault、路径及路径哈希，客户端预读不能替代服务端原子条件删除。附件同步 End 中的时间推进不能代替分片完整落盘。上述边界必须通过固定服务端能力证据决定可执行或 `blocked-capability`，不得照搬后宣称数据安全。

Headless 新增持久化状态机、内容版本核对及冲突契约；协议动作、编码、分片和分页实现仍来自共享模块。Node 已直接消费共享认证、传输、DTO 与 protobuf 映射；没有实现协议副本或完整的伪 Obsidian runtime。后续每次抽取须在本表补上实际文件、两端消费者和回归证据。

## 当前补丁

| 文件 | 原因与范围 | 已运行回归 |
| --- | --- | --- |
| `tests/websocket-auth-error.test.mjs` | 更新过期模块加载路径，使用实际常量/格式化/认证分发 | `test:auth`；拒绝认证不进入同步 |
| `src/lib/storage/file_hash_manager.ts`、`tests/file-mirror-restore.test.mjs` | 先加载确认基线，避免本地缓存恢复过程中用空映射覆盖基线；不改变线上协议 | `test:mirror` 原场景及独立/空基线、旧格式迁移组合 |
| `protocol_hash.ts`、`helpers.ts` | 原算法搬移，注入让出与范围读取；插件包装与 Node 文件读取共用 | `test:hash` 固定稳定版金向量、阈值、20 MiB 盲区特征及两种宿主读取 |
| `websocket_client.ts`、`websocket_auth.ts`、`websocket_obsidian.ts`、`websocket_manager.ts`、`headless/connection.ts` | 抽取宿主 I/O 和认证协商；取消隔离旧连接事件与积压发送 | `test:transport`、`test:auth`；固定服务端 JSON/protobuf 客户端信息往返、取消与独立进程退出 |
| `headless/state_records.ts`、`headless/state_store.ts` | Node 专属事务元数据存储，不复制插件协议，不改变插件缓存 | `test:state`：事务回滚、重启、强制退出、实际写入权限失败、损坏与未知版本拒绝 |
| `headless/filesystem.ts` | Linux 受限目录访问、目录 inode 所有权锁；不在插件内引入 Node 文件 API | `test:filesystem`：真实独立进程争锁、崩溃释放、链接替换、路径/大小写保护及写入失败 |
| `headless/snapshots.ts`、`file_application.ts`、`conflicts.ts` | 外置不可变版本、本地文件与状态提交恢复、最小三方冲突；继续调用共享哈希 | `test:application` 的创建/替换进程崩溃与外部修改；`test:conflicts` 的首次冲突/三方/删除/二进制/重启 |

| `batch_sync.ts`、`sync_protocol.ts`、`note_protocol.ts`、`file_protocol.ts` | 从稳定版 operator/main/manager 抽取，两端实际消费；修复即时 Ack 竞态、宿主间会话串扰和关闭后残留 timer | `test:pull` 与固定服务端 JSON/protobuf 笔记/附件接收探针，插件 build/lint 和继承测试 |
| `headless/collection_pull.ts`、`note_pull.ts`、`file_pull.ts`、`download_chunks.ts` | Node 完成与资源策略；共享分页状态机，分片全到齐且内容校验/落盘完成后才推进页；拒绝只读上传请求 | 乱序/重复/缺片、内容改变、End 提前、应用失败、取消、完整 SHA-256、跨进程中断恢复 |
| `headless/download_batch.ts`、`durable_note_pull.ts`、`durable_file_pull.ts` | 事务批次/会话落盘；重启从零请求远端清单，不采用未完成检查点 | SQLite 提交失败、End 不提交、强制终止后的全量重读、幂等重复与本地冲突保留 |

完整插件回归见 `VALIDATION.md`。目前有独立 Node 的笔记/附件只读接收接口与隔离验证入口；身份绑定尚未接入，这些接收接口只由拥有明确新建目标的合成探针调用。本地完整内容扫描与周期核对见 `headless/scanner.ts` / `test:scan`；双向发送确认、冲突决策应用及通用同步 CLI 仍待实现。

## 证据边界

- Project / Worktree：当前仓库、`headless/stable-2.4.0`，使用本工作区独立 `.codegraph/` 索引。
- Evidence：CodeGraph 当前源码与调用关系，必要的直接源码片段、稳定版差异及继承测试。
- Limit：静态调用图不能证明服务器条件写能力，也不能证明真实 Obsidian/Hermes 集成；原测试未覆盖的协议行为仍需新增合成测试。
- Next：固定服务端能力验证后，按 OpenSpec 逐项抽取并更新本清单。
