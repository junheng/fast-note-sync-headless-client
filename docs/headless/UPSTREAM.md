# 上游维护与发布方案

## 来源

- 上游：`https://github.com/haierkeys/obsidian-fast-note-sync`
- 本 fork：`https://github.com/junheng/fast-note-sync-headless-client`
- 上游默认分支：`master`
- 当前开发基线：正式 release `2.4.0`，提交 `f2b15c09d34e621d2d97ad526fdee03460bac151`，详见本目录 `BASELINE.json`。
- 版本选择策略：以已发布、非 draft、非 prerelease 的稳定版本 tag 及其精确提交为基线；不以 `master` / `main` 分支头作为开发基线。包版本号相同不代表代码处于该 release。
- 协议服务端参考：`https://github.com/haierkeys/fast-note-sync-service`，集成测试另行固定精确提交和镜像。

本项目继承完整 Git 历史。原插件主 README 保存在根目录 `README.upstream.md`；更新上游时需同时核对该参考副本。

## 分支与 remote

- `origin` 指向自己的 fork，`upstream` 指向官方仓库。
- 当前实施分支为 `headless/stable-2.4.0`：从稳定 tag 建立，再移植项目准备文档提交。原 `master` 保留最初的准备历史，不作为当前源码基线。
- 上游 `master` 仅用于观察尚未发布的变化；升级时在独立 `sync/upstream-<tag>` 分支合并经过验证的正式 release tag，然后提交 PR 到当前实施分支。
- 当前分支与旧 `master` 的基线不同，不能直接合并旧 `master`，否则会重新引入尚未纳入稳定版的改动；默认分支调整属于单独的仓库维护操作。
- 不使用会重置本 fork 主线的强制同步，不对已共享主线 rebase 或 force push。

以下为维护步骤示例，不是已安装的自动任务：

```sh
# 先核实目标 release 非草稿/预发布，并记录 tag 的精确提交。
git fetch upstream tag <稳定版tag>
git switch headless/stable-2.4.0
git switch -c sync/upstream-<稳定版tag>
git merge --no-ff <已核实的稳定版提交>
# 解决冲突、执行兼容测试、更新 BASELINE.json，再推送该分支并提交 PR。
```

工作区必须先处理好自己的未提交变更。合并时保留 Headless 的 README、包身份与发布策略，审查上游对应字段的变化，不对整个目录选择 ours/theirs。

## 更新节奏与门禁

建议每周检查正式 release；协议兼容或数据完整性修复可以加急评审。确需引用未发布的修复时，必须作为有来源提交、必要性说明和回归测试的独立 backport，不通过跟随分支头混入其他开发改动。初期手动操作，测试与发布体系成熟后再添加自动创建 PR 的任务。**自动发现更新不等于自动合并，更不等于自动部署。**

每次升级至少检查：

1. 消息字段、序列化、哈希、分页、Ack 和冲突处理是否变化。
2. 宿主适配接口及状态格式是否变化，已有状态如何迁移和回滚。
3. 依赖、运行时要求、许可证和发布脚本变化。
4. 原插件构建、Headless 测试、故障恢复及双方字节一致性验收。
5. 与实际部署服务端版本的兼容性，而非仅与最新服务端兼容。

新增能力尽量集中在适配层；必要的核心接口抽取使用独立提交，便于未来贡献上游。不能为了减少合并冲突牺牲数据完整性。

## 许可证与继承的发布配置

初始基线的根 `LICENSE` 是 Apache-2.0 文本，而 `package.json` 的 `license` 为 MIT。准备阶段保留这些上游内容，不自行改变既有代码的授权。正式分发前核对来源与适用声明，补齐准确的包元数据及需要保留的声明。

`.github/workflows/` 中的 release、pre-release 和 mirror 工作流来自原插件，不能视为 Headless 发布流程。fork 默认禁用的工作流不要直接全部启用；阶段 0 审查触发条件，发布阶段明确替换或限制旧流程。本次不配置定时更新，也不创建 release、tag 或容器发布。

### 稳定版继承工作流审计

2026-09-16 核对本地 `2.4.0` 继承配置：

| 文件 | 触发条件 | 主要外部副作用 |
| --- | --- | --- |
| `release.yml` | `master` push 且涉及 `manifest.json`，后续检查版本变化 | 构建插件、GitHub release、构建证明、CNB tag/产物上传 |
| `pre-release.yml` | 非 `master` 分支 push 且涉及 `manifest.json`，后续比较版本 | 插件预发布、CNB tag/产物上传 |
| `m-release.yml` | 手动 `workflow_dispatch`，可指定 tag 和说明 | 插件 release、构建证明、CNB tag/产物上传 |
| `mirror-to-cnb.yml` | 任意分支/tag push，以及 delete | 向固定上游 CNB 地址 force push 所有分支与 tag |

四者的 job 均检查 `github.actor == 'haierkeys'`。这是现有配置事实，不等于 Headless 发布隔离方案，也不证明远端 Actions 当前是否启用。未执行以上工作流，未修改其触发配置。发布里程碑应另行替换或限制它们。

本地候选验证只调用 package scripts，不调用 Actions 或发布工具。先选择 `.node-version` 指定的运行时，再执行：

```sh
npx --yes pnpm@11.1.2 install --frozen-lockfile
npx --yes pnpm@11.1.2 run test:hash
npx --yes pnpm@11.1.2 run test:transport
npx --yes pnpm@11.1.2 run test:state
npx --yes pnpm@11.1.2 run test:filesystem
npx --yes pnpm@11.1.2 run test:application
npx --yes pnpm@11.1.2 run test:conflicts
npx --yes pnpm@11.1.2 run test:local
npx --yes pnpm@11.1.2 run test:auth
npx --yes pnpm@11.1.2 run test:mirror
npx --yes pnpm@11.1.2 run test:vault-name
npx --yes pnpm@11.1.2 run build
npx --yes pnpm@11.1.2 run lint
git diff --check
git diff --exit-code -- pnpm-lock.yaml
```

目前 `build` 仍产出插件 `main.js` 等本地产物，不能作为 Headless 已可发布的证据。后续加入 Node 构建和协议/恢复测试时扩充本地门禁。

## 已知上游限制的维护

2026-09-16 已在稳定客户端 `2.4.0` / 服务端 `3.6.1` 组合复现大附件采样盲区。用户明确决定暂不自行修复，等待上游正式稳定版；本 change 将专项修复及三端验收延后，继续其他首版任务。证据和范围见 `SERVER-CAPABILITIES.md`。升级候选涉及附件哈希或上传检查时，重跑已有探针，再评估恢复专项验收；未通过前继续披露限制，不能将延期视为修复完成。

## 发布与部署

Headless 版本需独立标识，不沿用原插件版本号宣称 Headless 成熟度。当前 package 版本仍是上游基线，并设置 `private: true` 防止误发布 npm 包。

发布产物关联精确 Git 提交、上游基线、测试服务端版本和不可变镜像摘要。生产由 Hermes Ops 单独执行部署；必须有已验证备份、互斥切换与回滚方案。
