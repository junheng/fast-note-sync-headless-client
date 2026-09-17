# 本地修改与冲突决策契约

本客户端不依赖 Hermes。Hermes Ops 将以下控制入口接给 Bot 与馆长，部署、任务路由和访问权限由 Ops 管理。协议版本为 1；服务端行为沿用官方稳定插件，不要求修改上游。

## 访问方式和权限

先启动 `daemon`。同一容器内使用 `node /app/cli.cjs <命令>`，本机使用 `node dist/headless/cli.cjs <命令>`，均设置同一个 `FNS_STATE_DIR`。底层为状态目录内 `0600` Unix socket，目录 `0700`，每个连接一条以换行结束的 JSON 请求和响应。最多 4 个连接，单帧最多 16 MiB；未提交完整请求的连接 5 秒关闭。查询客户端等待最多 30 秒，超时不代表决策没有生效，应查询决策或重试相同幂等 ID。

Ops 应由受信任桥接进程持有控制入口访问权，限制 Bot 直接写笔记及状态目录。不要把状态目录、SQLite 或所有快照直接暴露给不受信任调用方。客户端同 UID 控制入口不区分 Bot/馆长角色：馆长专属决策权限由 Ops 桥接实现。

普通同步状态不含私有路径或正文；下述显式冲突查询会返回路径和版本信息，快照接口会返回内容。其输出只能交给授权解决者，不进入普通日志、工单摘要或本仓库 Git。

## 受控本地修改

`local-write` 从 stdin 接收请求。下面是合成笔记创建示例，真实使用时由调用程序生成 JSON，不把正文放进 shell 参数：

```json
{"requestId":"example-create-1","operation":"create","path":"example.md","contentKind":"note","expected":null,"contentBase64":"c3ludGhldGljCg=="}
```

将请求保存在受限文件后，通过 stdin 交给客户端：

```sh
node dist/headless/cli.cjs local-write < .local/request.json
```

| 操作 | 必需额外字段 | 预期版本 |
| --- | --- | --- |
| `create` | `contentBase64` | `expected: null`，路径必须不存在 |
| `modify` | `contentBase64` | 当前完整 SHA-256 与字节数 |
| `delete` | 无内容字段 | 当前完整 SHA-256 与字节数 |
| `rename` | `targetPath`、`targetExpected: null` | 来源完整 SHA-256 与字节数，目标不存在 |

版本形如 `{"sha256":"64位小写十六进制摘要","size":123}`。`contentKind` 为 `note` 或 `file`；内容采用标准 Base64，笔记必须是有效 UTF-8。`requestId` 在当前状态目录内唯一；相同 ID/相同载荷重复请求返回已有结果，相同 ID/不同载荷拒绝。

响应信封为 `{"ok":true,"result":...}` 或 `{"ok":false,"code":"..."}`。本地结果 `status: applied` 和 `synchronization: not-confirmed` 只表示本地修改持久化。`stale` 表示当前版本或重命名目标已改变，调用方必须重新读取并作新决定；不能忽略条件强行覆盖。远端成功以之后的同步确认和检查点为准。

## 查询冲突及内容

```sh
node dist/headless/cli.cjs conflicts
node dist/headless/cli.cjs conflict CONFLICT_ID
node dist/headless/cli.cjs decision DECISION_ID
```

`conflicts` 每页最多 100 条，包含历史记录；下一页用 `conflicts NEXT_ID`，没有下一页时 `next: null`。只将 `status: open` 分配给解决者。`superseded` 指版本已变化或被新一轮取代，`resolved` 指已完成所选版本的确认。原快照仍保留。

冲突详情包含 `formatVersion: 1`、`id`、`path`、`contentKind`、`baseStatus`、`base/local/remote` 和 `status`。`baseStatus` 明确区分 `missing`（没有共同基线）、`absent`（已知不存在）和 `present`。非空版本包含完整 SHA-256、字节数、上游协议哈希和受控快照 ID；上游协议哈希不能代替完整摘要。

通过 `conflict-snapshot` 的 stdin 请求读取指定冲突关联的版本，不接受任意快照路径：

```json
{"conflictId":"CONFLICT_ID","side":"local","offset":0,"length":1048576}
```

`side` 为 `base/local/remote`，每块最多 1 MiB。返回标准 Base64、版本摘要和下一块偏移 `next`；不存在的版本返回 `version: null`，不是空文件。每次读取都验证持久快照完整性。调用方拼接后再核对 SHA-256 和字节数。

## 提交馆长决策

`resolve` 从 stdin 接收版本化决定，合成结构如下。完整摘要及长度必须从对应冲突详情复制，不能采用当前时间或仅用协议哈希：

```json
{
  "schemaVersion": 1,
  "decisionId": "example-decision-1",
  "conflictId": "CONFLICT_ID",
  "action": "merge",
  "expectedLocal": {"sha256": "64位本地完整摘要", "size": 10},
  "expectedRemote": {"sha256": "64位远端完整摘要", "size": 11},
  "contentBase64": "bWVyZ2VkCg=="
}
```

| 决策 | 行为 |
| --- | --- |
| `merge` | 使用 `contentBase64` 的合并字节；Base64 字段最大 12 MiB |
| `keep-local` | 选择该冲突所引用的本地版本，可能是删除 |
| `keep-remote` | 选择该冲突所引用的远端版本，可能是删除 |
| `delete` | 确认两端删除该路径 |

非 `merge` 决策不得包含 `contentBase64`。`expectedLocal/expectedRemote` 在对应版本不存在时必须为 `null`。请求不接受路径替换或任意快照引用。相同 `decisionId` 的不同有效载荷返回 `decision-id-reused`；同一路径已有未完成决策时拒绝新决定，先查询/恢复原决定。

```sh
node dist/headless/cli.cjs resolve < .local/decision.json
node dist/headless/cli.cjs decision example-decision-1
```

决策结果包含 `decisionId`、`conflictId`、`status`、`synchronization`、`nextConflictId`。仅 `status: resolved` / `synchronization: confirmed` 表示目标版本已经正常读回确认并持久化。`pending` 仍待确认；网络超时返回错误也可能已在远端执行，使用相同 ID 重试会先读回，不重复覆盖后继版本。

若任何完整版本已变化，旧决定返回 `stale` 和新的 `nextConflictId`，保留双方及旧基线快照。馆长必须针对新冲突作新决定。新记录可带 `reason: versions-changed`；即使当前双方已相同，旧合并内容也不会被当成有效决定自动应用。复核与本地落盘共用 Bot 的所有者互斥；决策的未完成本地意图不会被普通请求恢复直接执行，重启会先重新验证远端。远端复核之后的竞争仍受官方协议约束，本客户端不声称新增原子 CAS。

## 原始 socket 信封

| `action` | `request` |
| --- | --- |
| `status` | 不带 request 字段，仅 `schemaVersion` 和 `action` |
| `local-write` | 上述本地修改请求 |
| `conflict-list` | `{}`，或 `afterId` / `limit` |
| `conflict-detail` | `{"conflictId":"..."}` |
| `conflict-snapshot` | 上述分块快照请求 |
| `resolve` | 上述决策请求 |
| `decision-status` | `{"decisionId":"..."}` |

除 `status` 外，外层固定为 `{"schemaVersion":1,"action":"...","request":{...}}`。未知字段、错误版本和非法路径拒绝。不要直接改状态数据库来处理冲突。

## 可重复合成验收

```sh
pnpm run test:conflicts
node scripts/probe-server-capabilities.mjs --reconcile
node scripts/probe-server-capabilities.mjs --reconcile --server-version=3.5.1
```

探针只使用自行创建的本地固定服务端、临时账号和合成笔记，验证完整冲突生成、馆长决策模型、重复提交、控制查询、分块快照与实际 CLI 合并后双端逐字节核对。独立 Bot 进程测试覆盖两种先后顺序及七个强制退出边界。它不连接真实凭据，也不替代 Hermes 角色授权、真实 Obsidian 和业务回执。
