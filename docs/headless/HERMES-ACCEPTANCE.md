# Hermes Ops 验收交接

本仓库交付通用 Node/Docker 客户端，Ops 负责部署和角色桥接。这里的“隔离验收”指独立测试 Vault、客户端目录和凭据权限，不要求新增一种“隔离服务”。本仓库自动探针自行启动本机临时固定服务端，供可重复协议验证；Ops 可在自己维护的既有服务上选择专用测试 Vault。

## 交付物和版本

- 来源：官方稳定插件 2.4.0，精确提交见 [BASELINE.json](BASELINE.json)，保留原插件构建。
- 已验证原版服务端：3.5.1、3.6.1，镜像固定摘要及继承限制见 [SERVER-CAPABILITIES.md](SERVER-CAPABILITIES.md)。不修改官方服务端。
- 镜像：Gitea 每次推送按完整源码 SHA 构建，当前自动发布 Linux ARM64；AMD64 使用方可从同一 Dockerfile 构建。必须记录实际使用的 commit、镜像摘要和架构，不能只记可变标签。流程见 [DOCKER.md](DOCKER.md)。
- 运行入口：`once`、`daemon`、`status`、`local-write`、冲突查询、分块快照、`resolve`、`decision`。协议见 [CONTROL.md](CONTROL.md)。历史只读预览镜像不具备双向入口。
- 本轮真实验证记录见 [VALIDATION.md](VALIDATION.md)。完整目录和资源专项尚待完成，不把通用文件双向通过当作最终完整 MVP。

## 本仓库已提供的复测

```sh
pnpm run build
pnpm run build:headless
pnpm run test:sync
pnpm run test:conflicts
pnpm run test:local
pnpm run lint
node scripts/probe-server-capabilities.mjs --reconcile
node scripts/probe-server-capabilities.mjs --reconcile --server-version=3.5.1
podman build -t localhost/fast-note-sync-headless-client:local .
node scripts/probe-server-capabilities.mjs --container-sync
```

上述探针不读取真实凭据或笔记；使用独立临时服务、合成账号、笔记和分片附件，运行数据位于忽略的 `.local/`，结束后清理。验证协议收敛、持久恢复、受控接口和冲突决策模型，不代替实际 Obsidian 或 Hermes 的业务验收。

## Ops 执行与回执

1. 选择专用测试 Vault，保存上游及客户端数据备份。配置端点、token 文件和持久目录，记录镜像/源码版本。使用既有状态必须保持绑定的端点、主体、Vault 和本地目录身份，不用删除数据库解决错配。
2. 停止会写入该目标目录的旧同步程序，启动本客户端 `daemon`。Bot 通过受信任桥接调用 `local-write`；只有馆长角色可以通过桥接调用 `resolve`。配置 `controlled` 不会自动创建角色授权或禁止绕过写盘，需部署权限单独保证。
3. 使用实际 Obsidian 插件和 Bot，分别创建、修改笔记及附件，确认另一端完整 SHA-256/字节数一致；记录 `once`/daemon 回执中确认状态，不把连接成功视为同步成功。
4. 让双方编辑同一基线版本，确认生成 open 冲突、三方版本存在。馆长查询快照、提交有效决定；只有 confirmed/resolved 才关闭任务。另在决定生成后再次编辑远端，验证旧决定 stale 且关联新冲突。
5. 在本地应用和网络确认期间分别停止/重启客户端，确认没有丢失后继编辑、重复删除或重命名。重复提交相同 ID 得到同一终态；相同 ID 不同载荷拒绝。
6. 以 Bot 的实际运行身份尝试绕过桥接直接写笔记及状态目录，要求被权限拒绝；同时确认桥接的受控请求可以成功。以同一目录尝试第二个客户端，要求所有权冲突。

回执只需包含：环境代号、时间、客户端 commit/镜像摘要/架构、服务端及插件版本、场景 ID、是否通过、内容长度/摘要是否相等、冲突与决策 ID、重启前后状态及权限测试结果。不发送令牌、笔记正文、完整日志或私有路径。客户端负责通用机制；馆长路由、Bot 权限和真实业务往返由 Ops 回执确认。

没有外部回执时，OpenSpec 8.5 保持未完成；本仓库的合成 resolver 和两个 Node 实例不能代替它。生产切换与正式发布仍由 Ops 在完成所需验收后安排。
