# 准备阶段验证记录

日期：2026-09-16。上游基线：`1bfb406966d612a61831462bf381bbcd1c73f334`。

环境：Node.js `v24.18.0`，满足包声明的 `>=24.14.0`；pnpm `11.1.2`，使用 `npx --yes pnpm@11.1.2` 调用，无需全局安装。后续 CI 按 `.node-version` 固定运行时。

## 本次已做

- 创建 `junheng/fast-note-sync-headless-client` GitHub fork，并保留官方父仓库关系。
- 完整克隆 Git 历史，配置 `origin` 为自己的 fork，`upstream` 为官方仓库。
- 重写项目 README，保留原 README 副本，新增 AGENTS 与实现/维护交接文件。
- 将包名改为 `fast-note-sync-headless-client`，设置 `private: true`；保留上游依赖、版本和源代码。
- 同步旧 npm 锁文件中的包名；没有用旧 npm 锁文件安装依赖。
- 添加本地环境、索引、测试数据与状态目录的 Git 忽略规则。
- 未实现 Headless 服务，未部署生产，未创建定时合并、release 或新发布流程。

## 实际运行结果

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

## 下一位 Agent 首先处理

1. 在固定运行时复现基线；修正 auth 测试对旧路径和旧模块结构的假设。
2. 调查 mirror 测试的恢复契约；不能仅修改期望值让测试变绿。
3. 用独立提交修复翻译键类型与 lint 问题，避免与核心抽取混在一起。
4. 建立可重复的插件基线后，执行 HANDOFF 的阶段 1；新增 headless 测试应覆盖实际宿主边界。

本次仅验证项目准备与上游基线，没有运行真实 Vault 同步、双向服务集成或馆长任务验收。
