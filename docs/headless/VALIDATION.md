# 基线验证记录

## 2026-09-17：协议故障注入矩阵汇总

任务 8.1：新增 [FAULT-MATRIX.md](FAULT-MATRIX.md) 与 `test:faults` 入口（`run-s test:state test:application test:conflicts test:local test:scan test:pull test:sync test:resources`，约 40 秒，退出码 0）。矩阵按发送与确认、附件会话与分片、落盘与提交边界、身份与资源分组，逐项列出注入点、覆盖套件和判定依据，并明确每个场景以持久化状态与完整内容摘要或逐字节比较判定，发送成功、连接成功或日志计数不作为同步证据。

矩阵只汇总已存在的合成故障注入，不新增通过声明：文件应用的 8 个进程崩溃窗口、冲突决策与本地操作的 SIGKILL 位置、事务提交边界、批次与分片异常、身份错配和资源上限均来自对应套件的现有断言。`test:faults` 与 `test:all` 都可在固定 Node.js `v24.14.0` 下重复运行，固定服务端探针仍只用于确认替身没有虚构协议能力。OpenSpec 更新为 **42/50**。

## 2026-09-17：复用清单、上游合并清单与门禁

任务 8.3：新增 `test:all` 作为单一测试门禁，依次运行 14 个套件（`test:auth/hash/transport/mirror/vault-name/state/filesystem/application/conflicts/local/scan/cli/pull/sync/resources`），耗时约 1 分钟，退出码 0。插件 `build`、`build:headless` 与 `lint` 同时通过，`git diff --check` 与 OpenSpec strict 校验通过，`pnpm-lock.yaml` 未改写。

`REUSE.md` 补齐两端消费者与回归覆盖表：每个共享协议模块列出插件消费者、Node 消费者和对应回归入口；Node 专属宿主/持久化/恢复文件单独列出，避免被误认为协议副本。原本断开的补丁表已合并为一张表，并补记只读大小写变体处理。`UPSTREAM.md` 新增上游合并检查清单（稳定 tag 核实、合并分支、REUSE 差异核对、本地门禁、固定服务端探针、文档与 backport 记录、不触发继承发布流程），并把过期的本地命令列表替换为 `test:all`。

上游改动仍按稳定 release 独立评估，未启用或运行继承的 release / mirror 工作流。OpenSpec 更新为 **41/50**。

## 2026-09-17：附件上传会话与删除保护复核

任务 5.1 与 5.2 的声明行为已按现有实现逐项复核，缺少的会话丢失场景补齐后均通过。

- **附件发送版本**：`DurableOutbox` 只保存不可变目标快照、预期远端版本和操作顺序，`sent` 在发送前提交连接代次与请求 context；基线只在完整读回匹配具体发送版本后提交。
- **会话过期与取消**：新增 `expired-session` 用例：服务端收齐全部分片后不返回 `FileUploadAck`，客户端超时保持 `sent` 且不写基线，重试时重新 `FileUploadCheck` 并从快照完整重传。用例断言两次请求的 `sessionId` 不同、远端在第一次尝试后仍无内容、第二次确认后才提交基线。取消后的重建会话行为保持原断言。
- **Ack 丢失**：既有用例断言读回已存在版本时恢复基线而不重复发送；删除与重命名在 Ack 丢失后按官方路径语义恢复，不新增服务端字段。
- **本地删除意图**：本地缺失只有在完整成功扫描、且已确认基线等于远端当前版本时才生成持久删除操作；没有基线时缺失只触发重新接收，不构成删除意图。
- **远端删除保护**：远端缺失缺少回收历史证据时只计数 `historyUnverified` 并保留本地文件；扫描失败、取消、混合读取和事务提交失败保留上次成功清单，同路径目录替换由所有权身份检查拒绝，均不产生删除操作。
- **删除对修改**：本地编辑对远端删除、以及冲突决策执行前的版本变化都保留 base/local/remote 快照并产生新冲突，不按时间戳覆盖。

历史保留期到期无法在探针内等待，因此按“缺少证据不删除”处理，保留为已知未知项。实际 3.5.1/3.6.1 的离线删除、重启恢复与 9 MiB 分片附件双向传递由 `--rename-sync` 探针覆盖。OpenSpec 更新为 **40/50**。

## 2026-09-17：重命名与目录操作复核

任务 5.3 的来源/目标复核已接入：受控重命名在发送前核对已确认基线、远端来源版本和目标占用；远端路径变化按每个路径的完整版本独立判定。`test:sync` 的整轮用例新增远端大小写重命名、远端目录整体移动、远端重命名指向已有不同本地内容的目标、本地重命名对远端修改，以及离线重命名的发布顺序。

- **大小写重命名**：修正只读查询对大小写变体的处理。旧名称在本地只存在同名异写的新路径时按“不存在”回答，写入、创建和身份声明仍拒绝大小写变体（`test:filesystem` 断言 `readOptional("case.md") === null`，而 `write("case.md", "create")` 仍返回 `case-collision`）。修复前，远端把 `nested/renamed.md` 改名为 `nested/Renamed.md` 后，接收端在后续轮次读取旧名称时抛出 `case-collision`，整轮同步持续失败；该回归由新增用例复现后修复。
- **目录操作范围**：本轮覆盖重命名所需的父目录创建、来源/目标版本复核和大小写碰撞拒绝；远端目录整体移动表现为逐文件路径变化并按路径收敛。官方 `FolderSync*` 通道（空目录传播和目录重命名消息）尚未实现，仍记录在任务 5.6 与已知限制中，不据此声明完整目录同步。
- **离线重命名**：没有受控请求时按新建加删除处理，新路径在远端确认后才删除来源；用例按实际上传顺序断言 `put:offline-moved/offline-b.md` 早于 `delete:offline-a.md`。
- **目标碰撞**：远端重命名目标已有不同本地内容时保留冲突记录与双方快照，本地目标文件不变，本轮没有远端写入，也不先删除目标。
- **重命名对修改**：本地受控重命名后远端修改来源时，来源路径记录冲突（本地缺失、远端版本保留），移动后的内容仍按新路径发布，双方内容都不被覆盖。

固定服务端重命名矩阵：`node scripts/probe-server-capabilities.mjs --rename-sync`（另有 `--server-version=3.5.1`）在正式 3.6.1 与 3.5.1 镜像上退出码 0。探针只使用自己创建的临时实例，不接收外部端点或凭据，结果含笔记与附件的双向修改、离线删除、重启、幂等空同步、跨目录重命名、大小写重命名、冲突合并、CLI/常驻入口与凭据读取。能力边界见 [SERVER-CAPABILITIES.md](SERVER-CAPABILITIES.md)。

本轮同时运行 `test:auth/hash/transport/mirror/vault-name/state/filesystem/application/conflicts/local/scan/cli/pull/sync`、插件 `build`、`build:headless` 和 `lint`，均退出码 0。OpenSpec 更新为 **38/50**；空目录同步、固定服务端目录操作矩阵、实际 Obsidian 操作矩阵和外部 Hermes 业务回执仍未完成。

## 2026-09-17：通用冲突决策与受控接口

四种决策（合并、保留本地、保留远端、确认删除）已接入持久状态、所有者互斥和官方上传确认。新增分页查询、详情、最大 1 MiB 分块快照、幂等决策查询及 CLI `resolve`，契约见 [CONTROL.md](CONTROL.md)。未引入 Hermes 专用代码。

`test:conflicts` 覆盖文本/二进制、删除对修改、缺失基线、相同 ID 不同载荷、两端版本改变、同协议哈希不同完整摘要、确认丢失后重启读回，以及决策应用与独立 Bot 进程的两种顺序。七个实际 SIGKILL 位置为：决策 prepared、本地意图 prepared、文件发布、本地 applied、操作 sent、操作 acknowledged、决策 confirmed；恢复后逐字节与持久终态一致。另在未发布的本地意图后改变远端，确认普通恢复不会执行陈旧决策。

3.5.1 / 3.6.1 固定原版服务端分别通过增强 `--reconcile`：双端并发编辑产生冲突，合并和重复决定后内容收敛；实际 daemon/CLI 经控制入口查询版本、分块读取远端快照和提交合并，另一客户端完整读回一致。`runtime-identity.test.mjs` 验证实际运行入口在认证主体、端点、Vault、目录和同路径 inode 错配时不重放删除，保留文件与数据库；认证失败和 UID 无法取得同样拒绝恢复，相同主体的换 token 对照通过。

相关状态、同步、冲突、本地入口、CLI、插件/Node 构建和 lint 回归通过。OpenSpec 本轮更新到 **35/50**；完整目录操作、资源上限专项、实际 Obsidian 操作矩阵和外部 Hermes 业务回执仍未完成。

双向基础入口提交 `11fb4316a6cb32c3f5b87f0f229538a2f3396519` 的 [Gitea run 29](https://g1t.sigmoid.cc:53691/diomgis/fast-note-sync-headless-client/actions/runs/29) 已成功发布 ARM64 镜像 `g1t.sigmoid.cc:53691/diomgis/fast-note-sync-headless-client@sha256:d52bf83cd33faf3bdbd766b9f0a317ecd1b341c8b91b801f67cffdff5a5b6dd8`。该提交具备双向和常驻，但不包含本节之后才加入的冲突决定，使用方需固定与所验收功能匹配的源码/镜像版本。

## 2026-09-17：双向运行入口与容器增量

`SyncCoordinator` 已将认证身份、完整远端清单、不可变 outbox、本地扫描、下载恢复和共同基线接成整轮同步。`once`、`daemon`、`status`、`local-write` 使用独立 Node 构建，Docker 默认 `daemon`。最后本地扫描与 `cycle` 确认共用互斥，避免受控编辑插入扫描和成功提交之间。

- `test:sync` 新增整轮测试：双向修改、重开状态、离线删除、缺失回收历史保护、A 确认时本地已变 B、受控跨目录重命名、远端文件应用后/基线提交前故障、后继编辑及三方冲突持久保留。
- 原版服务端 **3.5.1 和 3.6.1** 分别通过 `--reconcile`：JSON 与 protobuf 两客户端双向笔记和 **9 MiB 分片附件**，逐字节比对，重启后的离线删除、远端删除落盘及稳定后的空同步。没有修改服务端代码。
- 同一探针启动实际 CLI 子进程：`once`、`daemon` 受控创建后远端读回、重复启动拒绝、SIGTERM 停止后重启、普通输出不包含合成令牌/正文/路径，均通过。
- 非 root、只读根文件系统、512 MiB 的 Dockerfile 构建在本机 rootless Podman 通过；3.6.1 的 `--container-sync` 验证实际容器上传、本地客户端读回、反向修改下载及复用状态重启。
- 新增空闲 socket 停止测试；Linux 控制 socket 经目录描述符寻址，已在实际较长仓库路径验证。旧请求重试、12 个强制退出场景和独立 Bot 进程互斥测试继续通过。

Node 24.14.0 / pnpm 11.1.2 下，现有全部测试套件、插件构建、Headless 构建通过。Node HTTP 适配采用原生 fetch，限定该适配文件使用 Node lint 规则，其余插件仍保留 requestUrl 约束；最终 lint 通过。锁文件没有改变。

此增量证明可运行双向**文件**同步；不将冲突快照保留等同于馆长决策完成。完整目录操作、冲突解决接口、快照总配额、实际 Obsidian 操作矩阵及 Hermes 回执仍待后续任务。当前 Docker 构建具备双向入口，历史只读镜像摘要保持原有能力。此处不声称完整 MVP 或生产部署完成。

## 2026-09-17：双向发送基础组件增量

新增 `test:sync`，身份绑定、不可变 outbox 和共享笔记/附件上传组件的合成测试通过。覆盖错误服务/主体/Vault/目录拒绝恢复、A 发送后本地变为 B、重复/错序/旧连接确认、Ack 丢失后重开状态并读回恢复、实际 SQLite 日志写入失败不发送、空附件、取消后新会话完整重传，以及缺少能力时保留意图。重命名来源/目标相交的操作按序执行；仅目标内容一致、没有来源消失证据时拒绝确认。

在 Node 24.14.0 下完成全部现有 `test:auth/hash/transport/mirror/vault-name/state/filesystem/application/conflicts/local/scan/cli/pull`、插件 `build`、`build:headless` 和 `lint`，均退出 0。新增套件用固定 pnpm 11.1.2 执行通过，锁文件未变化。随后按用户要求取消虚构 CAS 能力门禁，复用官方删除/重命名，原版 3.5.1 / 3.6.1 均通过 `--headless-write` 的 JSON/protobuf × 笔记/附件四类操作、完整读回与重开状态验证，没有修改服务端。当前 24/50，一次性双向/常驻入口尚未接入，已发布镜像仍为只读预览，完整需求未完成。

## 当前：正式稳定版 2.4.0

2026-09-16 按用户要求从正式 release `2.4.0` 创建 `headless/stable-2.4.0`，对应提交 `f2b15c09d34e621d2d97ad526fdee03460bac151`。GitHub release 元数据为 `draft=false`、`prerelease=false`；远端 tag 与本地解析提交一致。项目准备文档提交已移植，原 `master` 历史保留。

使用 `.node-version` 指定的 Node.js `v24.14.0` 和 `npx --yes pnpm@11.1.2`。修改源码前，`git diff --exit-code 2.4.0 -- src tests pnpm-lock.yaml` 通过。

| 命令 | 稳定版原始结果 | 证据 |
| --- | --- | --- |
| `install --frozen-lockfile` | 通过 | 锁文件未变化 |
| `run test:auth` | 失败 | 测试仍读取已不存在的 `src/lib/websocket.ts` |
| `run test:mirror` | 失败 | 第 152 行预期 `hash-a`，实际 `null` |
| `run test:vault-name` | 通过 | 退出码 0 |
| `run build` | 通过 | TypeScript 与插件打包通过 |
| `run lint` | 通过 | 退出码 0 |

`pnpm-lock.yaml` 的 SHA-256 为 `2cc8064c2a468954558d450f3ecc24d2a4313b80d444bbd6a52dc99240cc6fe7`，安装前后相同。以下旧记录中的翻译键类型和 lint 错误属于 release 后的开发提交，不在稳定版上进行无意义的修复。

### 稳定版修复与完整回归

同日完成以下两项最小修复：

- auth 测试加载实际的 `websocket_manager.ts`、消息常量和错误格式化函数，保留 308/315 错误断言，并验证认证失败不会启动同步或发送客户端信息。
- `FileHashManager.initialize()` 先恢复已确认同步基线，再恢复、迁移或重建本地缓存。原顺序会在基线尚未加载时保存空映射，覆盖原有确认记录。回归保留原场景，补充本地缓存与确认基线不同、空基线、镜像组合及旧格式迁移场景，确认未同步编辑不会变成已确认版本。

修复后在 Node.js `v24.14.0` / pnpm `11.1.2` 上完整运行 `test:auth`、`test:mirror`、`test:vault-name`、`build` 和 `lint`，全部退出码 0。`git diff --check` 通过，pnpm 锁文件未改变。旧开发分支的翻译键/lint 修复没有移入稳定版。

此结果仅证明稳定版插件基线及上述修复通过；不代表 Headless 服务或真实服务器双向同步已实现。

### 固定服务端能力探测

`scripts/probe-server-capabilities.mjs` 在正式服务端 `3.6.1` 的固定摘要镜像上退出码 0。已复现 20 MiB 附件的采样盲区：两种 mtime 变体均返回 code 6，WS 不请求上传，完整下载仍是旧内容；REST 对照可以存储并读回修改内容。探测完成后临时容器、卷和配置已清理。

本项通过表示探测与断言执行成功，功能收敛结果仍为失败。证据、可重复命令、未验证能力和当前范围决策见 `SERVER-CAPABILITIES.md`。用户随后明确决定等待上游修复：该采样盲区记录为已知限制，专项任务移出首版必需范围，不再阻塞整体实施。后续已完成基础抽取与本地存储/目录组件，见下节；完整 Headless 双向同步仍未实现。

### 共享模块与 Node 基础组件

2026-09-16 完成任务 2.1–2.6，当前 OpenSpec 完成 **13/49** 项，另有 3 项明确延后。

- 哈希算法原样移至共享模块。金向量来自稳定版源码，覆盖中文、emoji、空内容、换行、10 MiB 两侧及 20 MiB 采样特征；插件包装与真实 Node 文件读取结果一致。
- 认证与传输共用上游实现和 protobuf 映射；Node 无 Obsidian runtime 依赖。覆盖取消后的迟到帧、背压中的旧连接发送、探测未结束时显式重启、后续认证拒绝、连接超时，以及插件原计数键迁移和认证/启动顺序。
- 固定服务端 `3.6.1` 的 `--connection-only` 探针验证 JSON/protobuf 的实际 ClientInfo 往返、认证失败、取消及独立进程退出码。未执行同步，临时容器、卷和配置已清理。
- 不可变快照与文件应用完成 8 个标准 SIGKILL 边界、发布后外部修改、状态提交失败和幂等恢复验证；首次同路径冲突及三方/删除/二进制快照在重启后保留，缺少基线被明确区分。
- SQLite 事务存储及 Linux 目录适配的范围、上限、实际故障和独立进程测试见 `STATE.md`。Node SQLite 驱动在固定版本中仍输出实验性警告；用户已确认运行目标为 Linux / Linux 容器（含 WSL）。

固定服务端的 `--write-preconditions` 探针两种编码均通过行为断言：旧基线修改被拒绝，陈旧删除可以删除后续已确认修改，重命名保护已占用目标但不核对来源版本。通过表示事实被复现，不表示这些风险写入满足验收；详见 `SERVER-CAPABILITIES.md`。

新增 `test:hash`、`test:transport`、`test:state`、`test:filesystem`、`test:application`、`test:conflicts`；继承的 `test:auth`、`test:mirror`、`test:vault-name` 继续保留。已接入外置快照、本地落盘恢复和最小冲突记录，尚未接入网络操作持久化与冲突决策应用，不能据此声明双向同步或 Hermes 验收通过。

最终在固定 Node / pnpm 上运行上述全部 9 个测试脚本、插件 `build` 与 `lint`，均退出码 0；OpenSpec strict 校验和 `git diff --check` 通过，pnpm 锁文件 SHA-256 未改变。额外复核修复了取消后的显式重连被旧探测吞掉，以及已认证连接后来收到认证拒绝仍继续分发的问题，并补齐对应回归测试。

## 受控本地入口与实际 Obsidian 宿主验证

2026-09-16：新增 `test:local`，全部 10 个测试脚本通过，插件 build 与 lint 通过。本地请求覆盖四种操作、完整版本前置条件、重复 ID、相同 ID 不同载荷拒绝、大小写/跨目录重命名及重启。独立所有者和 Bot 进程在真实文件替换边界验证两种执行顺序和竞争目标；删除/重命名共 12 个 SIGKILL/后继同内容文件场景通过。删除采用先保留原 inode、提交后清理，防止 inode 复用导致错误重放。详见 `STATE.md`。

已将当前插件构建产物安装到仓库外全新的 Windows-native Vault，并启动本机实际 Obsidian `1.12.7`。通过专用实例的回环调试端口先验证 Vault 和 user-data 目录身份，再仅为该测试 Vault 启用插件。实际宿主回执为 `pluginLoaded: true`、`pluginVersion: 2.4.0`、`vaultMatches: true`、`dataDirMatches: true`，笔记和配置同步均关闭。已正常关闭所启动实例，保留专用环境和脱敏回执。没有读取或修改用户默认 Vault/profile。

此结果证明当前插件可在实际 Obsidian 加载，不证明双向同步；任务 8.2 和 8.5 仍未完成。用户提供专用测试凭据后的连接与隔离验收说明见 `ACCEPTANCE-SETUP.md`。

## 无 Obsidian 的笔记/附件接收验证

2026-09-17：任务进度 **19/49**。新增 `test:pull`（共享批次、笔记分页、事务批次、附件分片四组）。固定 Node 24.14.0 / pnpm 11.1.2 上，全部 11 个测试脚本、插件 build 和 lint 均退出 0，lint 无警告。接收器恢复边界修正后重跑 `test:pull`、build、lint 与两组真实服务端接收探针，全部通过。

`scripts/probe-server-capabilities.mjs --note-pull` / `--file-pull` 都在全新固定服务端 3.6.1 上退出 0：JSON/protobuf、7 篇笔记 4 页、3 个附件 2 页、完整 SHA-256、重复接收、本地冲突、分片/分页中断恢复均通过。进一步在“文件发布后、应用记录提交前”强制终止实际进程，新的 Node 进程先重新读远端完整版本，再复用匹配的持久化应用记录；最终没有遗留 prepared 应用，也没有重复创建应用记录。来源、发送白名单、资源上限与附件摘要清单见 `SERVER-CAPABILITIES.md`。

共享抽取覆盖上游库存批次、NoteSync/FileSync、PageAck、下载请求与二进制分片；插件与 Node 均消费这些模块。构建断言没有载入 Obsidian、插件 main、operator 或宿主替身；服务器无需桌面环境。实际 Obsidian/Hermes 双向验收仍未完成。

`--identity-only` 另已退出 0：固定服务端当前用户和 Vault 可查询，两份同主体手动令牌观察到相同 UID 和 Vault 元数据。health 返回 `database/status/uptime/version`，没有可用的独立服务身份；`serviceIdentityVerified: false` 是证据范围，`recoveryGate: state-identity-unverified` 是当时的门禁评估（已被 2026-09-17 官方兼容边界取代），并非现有通用同步 CLI 已完成身份门禁。1.8、2.8 与 3.6 未勾选。

## 完整内容扫描

同日完成任务 4.1，当前 **20/49**。新增 `test:scan`，并通过受影响的 `test:state`、`test:filesystem`、build 和 lint。现共有 12 个测试脚本，均已有通过记录。

扫描在 Vault 所有者互斥下执行完整读取、不可变快照、最终完整内容复核与树结构复核后，事务提交一份观察清单；不把观察清单当成确认基线，也不从缺失自动生成删除意图。覆盖 `Aa`/`BB` 同协议哈希且保留 mtime/大小仍发现变化，扫描中较早文件被修改、目录读取失败、事务提交失败、取消、重启、同步落盘后 Bot 再编辑，以及未提供任何监听事件时周期扫描发现新文件。失败时保留上次完整清单，错误不携带正文或路径。

扫描本轮最多 10000 项、256 MiB 总内容，笔记/附件分别沿用 20/32 MiB 上限；未知直接写入者不属于受控并发保证。该功能不实现远端采样盲区审计或强制上传，未改变用户接受的上游例外。

用户明确本轮只做本地客户端实现、测试与交接，部署由其他 agent 负责；无需新增“隔离服务”。后续已授权使用现有知识库并提供本机 JSON 凭据，实际接入结果见下一节。

## 用户授权的现有服务接入

用户提供现有 JSON 凭据文件后，由程序直接消费 `api/apiToken/vault` 字段，没有将值打印或复制到本仓库。实际认证成功；当前远端为 3.5.1，笔记/附件列表可读，Vault 列表查询返回业务码 314。

接入前新增固定 3.5.1 镜像的本地笔记、附件和实际只读复制入口测试，JSON/protobuf、完整字节、分页及故障恢复均通过。真实库首轮因历史删除记录保守停止，无远端业务写入；随后补充“本地已经不存在”这一无操作路径的验证。单元测试同时证明本地存在同名文件时仍阻塞；本地服务端合成笔记/附件删除历史及完整复制入口测试通过后才重试真实库。这个处理没有实现无前置条件的文件删除，也没有放宽旧状态恢复门禁。

重试已完成 1223 篇笔记、25 页的只读接收和批次提交，另确认 1 条历史删除在本地已不存在。附件接收因一个 3803076 字节文件的内容哈希不匹配而停止，整个复制回执保持 `incomplete`。数据和回执均位于仓库外的独立运行目录，不覆盖用户原有本地 Vault。

停止后逐项复核已提交应用记录与本地文件：1223 篇笔记、208 个附件，共 67118727 字节，完整 SHA-256 和长度均匹配持久化版本；脱敏 `local-content-verification.json` 记录结果。这只证明已应用部分未损坏，不代表附件批次或整个知识库完成。

随后仅对该附件进行独立只读复核：15 个 WebSocket 分片齐全、组装长度正确；新发起的 HTTP 下载长度相同，完整 SHA-256 与分片组装结果一致；服务端记录的 `contentHash` 与两种下载结果按固定 2.4.0 算法计算的哈希均不匹配，转换为无符号整数也不匹配。脱敏 `attachment-readback.json` 保留这些布尔结果和计数，不包含路径、正文、令牌或实际哈希值。此证据表明所观察到的元数据与字节不一致，尚不能判断最初由哪个客户端或服务端环节造成；不能据此认定所有附件均有问题。

该文件小于 10 MiB，与用户暂缓处理的上游大文件采样盲区不同。没有跳过哈希校验、修写远端元数据、上传文件或宣布完整只读/双向验收通过。接收器将“列表与下载响应的元数据不同”保留为 `file-version-changed`，将“完整分片组装后的协议哈希不符”单独报告为 `file-content-hash-mismatch`，两者均在发布文件和确认页面之前阻塞。

错误码区分已通过 `test:pull` 的元数据变化与损坏分片用例，插件 build、lint、OpenSpec strict 校验和 `git diff --check` 通过。

元数据只读盘点为 909 个附件、660029075 字节，已超过当前每个集合 256 MiB 的默认接收上限。即使修复上述单文件不一致，完整复制仍需先实现并测试显式、有界的较大容量配置与传输时限，不能把单个问题修复等同于全库验收通过。

## Docker 交付验证

用户补充要求后新增任务 7.5，当前进度为 **21/50**。交付 `Dockerfile`、`compose.yaml`、配置模板和 `DOCKER.md`，`build:headless` 产出独立 Node bundle；开发验收脚本和容器共享 `scripts/lib/initial-copy.mjs`，没有复制第二套同步协议。构建检查拒绝测试代码和 Obsidian 宿主进入 bundle；运行镜像 `/app` 仅含 `cli.cjs` 与 LICENSE，默认 UID 1000、Node 24.14.0，不包含构建目录或 node_modules。

本机以 rootless Podman 构建同一 Dockerfile。`--container-pull` 在固定 3.5.1 和 3.6.1 上均通过：容器指定上游与 bind mount，下载 2 篇笔记和 2 个附件（含空内容），完整 SHA-256 一致，两个批次均持久化提交，状态目录回执与输出一致；token 文件及 JSON 凭据两种方式均通过。缺少排他写入声明时零文件副作用；重复使用非空目录返回非零，原文件和回执保持不变。只读业务发送白名单通过，合成凭据和文件路径未进入输出。Compose 配置校验通过；Docker CLI 在本机由 Podman 兼容层提供，没有宣称额外验证独立 Docker Engine。

新增 `test:cli` 覆盖独立构建、两种凭据文件、歧义配置/符号链接/超长文件拒绝、缺少写入声明及输出隐私。提交前回归发现扫描测试使用 Date 恢复纳秒精度 mtime 时可能出现 1 ms 差异，改为先设置确定的整秒时间再验证“mtime/大小/协议哈希相同但完整内容不同”；未放宽扫描断言。全部 13 个测试脚本已有通过结果，插件 build、lint 和 OpenSpec strict 校验通过。

镜像首次构建暴露遗漏上游已有 `pnpm-workspace.yaml` 导致安装脚本许可缺失，现已将该文件纳入构建上下文并原样使用。Node 镜像固定版本及摘要，pnpm 11.1.2 冻结安装通过，原锁文件未改变。`.dockerignore` 采用构建输入白名单，本机 `.local/` 凭据及运行数据不进入 Git 或镜像。

## Gitea 自动发布验证（2026-09-17）

私有构建仓库 `diomgis/fast-note-sync-headless-client` 已创建，新增本地 `gitea` remote。推送提交 `52cf3a50acad5f7ab29d6d3ab8d70774b08328d6` 自动触发 [Gitea Actions run 26](https://g1t.sigmoid.cc:53691/diomgis/fast-note-sync-headless-client/actions/runs/26)，API 确认任务结果为 `success`。使用本仓库专属的 `mac-mini-fns-headless` runner，复用现有 Colima Docker，未部署同步业务服务。

发布镜像为 `g1t.sigmoid.cc:53691/diomgis/fast-note-sync-headless-client@sha256:bf6624fa24bf9fe1aa1aa48a529dfac7e5543fb8aaf7bf2b674336d79ecdefe7`。流水线按该摘要拉取，验证架构 `arm64`、源码 revision 与提交一致，并在只读、非 root 容器中成功运行 CLI 帮助；镜像包已关联本仓库。独立查询 registry manifest 也确认该摘要和 Linux ARM64 子镜像。

接入中修复两项实际故障：macOS 无交互 runner 无法向 Keychain 写入 Docker 登录凭据，改为受限权限临时认证配置并在退出时清理；原 Node 固定摘要仅对应 AMD64，改为同版本多架构索引摘要，使 ARM64 原生构建通过。索引中的 AMD64 子摘要与此前本地验证的基础镜像相同。工作流 YAML、内嵌 shell 语法、Compose 自定义镜像引用及 `git diff --check` 均通过。

此项证明源码推送、自动构建、镜像发布与启动的交付链路可用。发布内容仍为一次性只读拉取预览版，ARM64 上未据此宣称完整协议回归、双向同步或 Hermes 业务验收通过。

## 历史：准备阶段的开发分支快照

<!-- 后续历史记录保持原验证时点，不代表当前实现状态。 -->

日期：2026-09-16。上游基线：`1bfb406966d612a61831462bf381bbcd1c73f334`。

环境：Node.js `v24.18.0`，满足包声明的 `>=24.14.0`；pnpm `11.1.2`，使用 `npx --yes pnpm@11.1.2` 调用，无需全局安装。后续 CI 按 `.node-version` 固定运行时。

### 当时已做

- 创建 `junheng/fast-note-sync-headless-client` GitHub fork，并保留官方父仓库关系。
- 完整克隆 Git 历史，配置 `origin` 为自己的 fork，`upstream` 为官方仓库。
- 重写项目 README，保留原 README 副本，新增 AGENTS 与实现/维护交接文件。
- 将包名改为 `fast-note-sync-headless-client`，设置 `private: true`；保留上游依赖、版本和源代码。
- 同步旧 npm 锁文件中的包名；没有用旧 npm 锁文件安装依赖。
- 添加本地环境、索引、测试数据与状态目录的 Git 忽略规则。
- 未实现 Headless 服务，未部署生产，未创建定时合并、release 或新发布流程。

### 当时实际运行结果

命令前缀均为 `npx --yes pnpm@11.1.2`。

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `install --frozen-lockfile` | 通过 | 安装 502 个包，pnpm 锁文件未变化 |
| `run test:auth` | 失败 | 测试读取已经不存在的 `src/lib/websocket.ts`，报 ENOENT |
| `run test:mirror` | 失败 | `tests/file-mirror-restore.test.mjs:152` 期望 `hash-a`，实际为 `null` |
| `run test:vault-name` | 通过 | 进程退出码 0 |
| `run build` | 失败 | `src/views/conflict-resolve-modal.ts:477` 使用的 `ui.conflict.diff_skipped` 不符合翻译键类型，TS2345 |
| `run lint` | 失败 | 同文件第 629、632 行存在 unsafe assignment / call，共 2 个错误 |
| `git diff --check` | 通过 | 本次修改无空白错误 |
| `git diff --exit-code -- src tests pnpm-lock.yaml` | 通过 | 上述源码、测试和 pnpm 锁文件相对上游基线未变化 |

这些失败是在继承源码上观察到的基线问题，尚未逐项修复，也不代表四个独立产品缺陷。特别是 mirror 测试失败可能涉及测试替身与源码行为不匹配，需要调查。

### 当时交接建议（已由稳定版基线和 OpenSpec 任务取代）

1. 在固定运行时复现基线；修正 auth 测试对旧路径和旧模块结构的假设。
2. 调查 mirror 测试的恢复契约；不能仅修改期望值让测试变绿。
3. 用独立提交修复翻译键类型与 lint 问题，避免与核心抽取混在一起。
4. 建立可重复的插件基线后，执行 HANDOFF 的阶段 1；新增 headless 测试应覆盖实际宿主边界。

本次仅验证项目准备与上游基线，没有运行真实 Vault 同步、双向服务集成或馆长任务验收。

### 资源限制实测增量

固定服务端 3.6.1、Linux rootless Podman、非 root/只读根文件系统、512 MiB 内存/2 CPU：`node scripts/probe-server-capabilities.mjs --container-sync` 通过。32 MiB 附件上传并由另一独立客户端完整读回，容器 cgroup 峰值 **260,608,000 字节**（一次合成测试观测值，不代表所有库存组合的峰值）。快照配额设为 1 字节时返回 `snapshot-limit`、退出 2，待上传文件保留且远端不存在；3 MiB tmpfs 状态盘写入 4 MiB 新内容时实际磁盘写满，返回 `scan-failed`、退出 2，原内容保留，未发送该文件。

`test:resources` 覆盖共享预算、重启计数、发布硬链接、遗留临时文件、发布后报错的预算重算、拒绝本地写入时保留原版本，以及实际完整扫描 288 MiB 成功和超出 1 GiB 保留旧清单。默认快照配额为 4 GiB，上限可配置至 16 GiB；当前无自动历史回收。

冲突接口提交 `f3456189de978569667eb501379cd9507940aa77` 已由 Gitea run 30 构建通过，ARM64 镜像为 `g1t.sigmoid.cc:53691/diomgis/fast-note-sync-headless-client@sha256:27d24fc421b78fd3cf3e876461cdb6c60d01e6cf3142a49f58122d78acdf3de6`。该镜像含双向文件同步、常驻与通用冲突决策；本节资源配额改动尚待下一次构建。
