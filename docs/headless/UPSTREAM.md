# 上游维护与发布方案

## 来源

- 上游：`https://github.com/haierkeys/obsidian-fast-note-sync`
- 本 fork：`https://github.com/junheng/fast-note-sync-headless-client`
- 上游默认分支：`master`
- 初始基线：见本目录 `BASELINE.json`。
- 协议服务端参考：`https://github.com/haierkeys/fast-note-sync-service`，集成测试另行固定精确提交和镜像。

本项目继承完整 Git 历史。原插件主 README 保存在根目录 `README.upstream.md`；更新上游时需同时核对该参考副本。

## 分支与 remote

- `origin` 指向自己的 fork，`upstream` 指向官方仓库。
- 本 fork 的 `master` 用于经过验证的 Headless 开发主线；上游主线通过 `upstream/master` 跟踪。
- 在独立的 `sync/upstream-YYYYMMDD` 分支合并上游，然后提交 PR。
- 不使用会重置本 fork 主线的强制同步，不对已共享主线 rebase 或 force push。

以下为维护步骤示例，不是已安装的自动任务：

```sh
git fetch upstream
git switch master
git pull --ff-only origin master
git switch -c sync/upstream-YYYYMMDD
git merge --no-ff upstream/master
# 解决冲突、执行兼容测试、更新 BASELINE.json，再推送该分支并提交 PR。
```

工作区必须先处理好自己的未提交变更。合并时保留 Headless 的 README、包身份与发布策略，审查上游对应字段的变化，不对整个目录选择 ours/theirs。

## 更新节奏与门禁

建议每周检查上游；协议兼容或数据完整性修复可以加急。初期手动操作，测试与发布体系成熟后再添加自动创建 PR 的任务。**自动发现更新不等于自动合并，更不等于自动部署。**

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

## 发布与部署

Headless 版本需独立标识，不沿用原插件版本号宣称 Headless 成熟度。当前 package 版本仍是上游基线，并设置 `private: true` 防止误发布 npm 包。

发布产物关联精确 Git 提交、上游基线、测试服务端版本和不可变镜像摘要。生产由 Hermes Ops 单独执行部署；必须有已验证备份、互斥切换与回滚方案。
