# Clario：同步 Inno PR #243 / Pi 0.99.2

同步时间：2026-10-04。上游固定为 [Inno PR #243](https://github.com/hhyqhh/inno-agent/pull/243)，提交 `663789c187e25f9efca97e9129701cc05702e24a`，此前参照为 `fc74cd6a283e8226a4307ea8c3046c715cb6e5f3`。

## 已落地

| 范围 | 结果 |
| --- | --- |
| 后端 Pi SDK / pi-ai | 0.84.2 → 0.99.2；严格沿用该上游锁文件，不追 npm latest |
| pi-mcp-adapter | 2.21.0 → 4.0.0 |
| 配套扩展 | permission-system 36.2.1、ask-user-question 2.12.0、todo 2.12.0、subagents 0.74.0、web-access 0.35.0 |
| 会话上下文 | 编辑消息分支、图片失败回退通过 `session.refreshContext()` 同步公开会话状态；实际 provider 输入有回归覆盖 |
| 教学测试 | 使用新版 `TranscriptContext`，保留教学入口和证据校验断言 |
| 上下文用量 | 新版 transcript 内含系统提示及工具声明；消息分类跳过 system，避免重复计权 |
| MCP 配置 | 管理文件改为 `mcp-adapter.json`；项目覆盖改为 `.pi/mcp-adapter.json` |

UI 所用 `pi-web-ui 0.75.3` 和根目录 `pi-ai 0.75.5` 保持上游版本；后端实际解析的 `pi-ai` 是嵌套安装的 0.99.2。运行最低 Node 版本改为 22.19.0；完整测试推荐 Node 24.x ≥24.15.0，本次为 24.19.0。

聊天、学习目标/材料入口、练习记录、工作区与 L1/L2/L3 沿用当前契约；本次没有调整界面设计。学习模式仍关闭渠道、桌面入口和复杂扩展，相关源码保留。

## MCP 的兼容处理

完整模式启动时，若管理目录只有旧 `mcp.json`，将其原样重命名；新旧文件同时存在则均保留，以 `mcp-adapter.json` 为准。迁移失败保留旧文件，不另建空模板，方便下一次重试。学习模式不会执行该迁移或加载适配器。

Pi 0.99.2 CLI 会默认带入原生 MCP，而且没有 `--no-mcp`。Clario 通过公开 `InlineExtension` 接口以同名空工厂替换原生 MCP，另拦截绕过工厂的 shell `mcp` 子命令。完整模式仍通过适配器 `/mcp` 或 Web 设置管理 MCP。真实 CLI 测试包含原生正向探针、项目 `+builtin:mcp`、显式 `-e builtin:mcp`、新旧文件共存和学习/完整模式切换。

项目内旧 `.pi/mcp.json` 不会被自动改写。需要继续使用项目级适配器配置时，将相关定义迁至 `.pi/mcp-adapter.json`；`.mcp.json` 等共享来源仍按适配器规则读取。

## 可复核结果

- 最终基线：111 个测试文件，862 项测试通过，无跳过；17 项基线工具自测通过。
- 构建、SQLite/FTS5、L2 检索评估、核心学习合成流程、真实 HTTP/PTY 均通过。
- 1618 个外部依赖包及依赖声明与已固定的上游锁文件指纹匹配；工作区名称/路径与 Node engine 为 Clario 本地元数据。
- 两份原迁移清单和 13 份历史基线证据保持原字节；原 Inno 目录的 611 个来源文件校验未变。
- 3200 服务恢复；页面、构建资源、manifest、学习模式、三层记忆及扩展关闭状态检查通过，应用配置未改变。
- 当前 Clario 配置没有真实模型密钥；实际模型教学和教学效果本次未验收。AgentSession 回归使用 SDK 的 faux provider；MCP 测试仅使用本地合成服务。

机器记录：[升级依赖基准](pi-0.99.2.json)、[本次验收摘要](pi-0.99.2-result.json)。完整基线在 `../../runtime/baseline/runs/2026-10-04T14-54-30-056Z-60593/report.md`，原始日志和 Vitest JSON 同目录。Web 检查在 `../../runtime/upgrades/pi-0.99.2-20261004/web-acceptance.json`。

复跑命令：在支持的 Node 环境下执行 `npm run baseline:verify`。基线会同时验证当前升级锁、来源链、旧证据与学习流程，不把原迁移时“依赖未变”的结论套用于升级后。

## 回退点

升级前快照：`runtime/upgrades/pi-0.99.2-20261004/before/`。

- `checkpoint.json`：629 个源码/配置模板文件的 SHA-256，快照内容已逐个复核。
- `source/`：升级前源码副本。
- `installed/`：升级前各工作区依赖与构建产物，可用于本机离线恢复。

回退应先停止 Clario 服务并备份当前新增工作，再依据验收摘要的 `changedFiles` / `addedFiles` 恢复相应源码：已有文件从 `source/` 复制回来，只移除本次新增且尚未产生后续修改的文件。随后用恢复的旧 lock 执行 `npm ci` 和构建，或恢复 `installed/` 对应目录，再启动服务。不要用旧源码覆盖运行数据；`runtime/clario` 和 `workspace` 不属于源码快照。

本次一直使用学习模式，未迁移个人 MCP 文件。若日后切到完整模式触发重命名，回退旧适配器时还需单独核对配置：只有确认旧 `mcp.json` 不存在时，才将管理目录里的适配器文件改回旧名；文件并存时先比较内容，避免覆盖。

## dg-piagent 技能兼容差异清单

当前全局技能仍声明 0.83.0，本次未直接修改。根据 0.99.2 安装包类型定义和 CHANGELOG，待同步事项为：

1. `Context` / `TranscriptContext` 与 `getCurrentSystemPrompt`、`getCurrentTools` 的 provider 测试示例。
2. SessionManager 作为会话持久状态来源；手动分支变更后调用 `refreshContext()`，避免直接写 `agent.state.messages`。
3. 扩展事件说明加入 `context_with_system`，重新核对“只有六个扩展独有事件”的旧结论。
4. 内置原生 MCP、适配器独立配置路径和 CLI `InlineExtension` 覆盖契约。
5. 安装 Node 最低版本、以及混合 Web/后端依赖时检查实际解析版本的说明。

技能引用的 `references/skill-maintenance.md` 当前缺失，因此本次以实际 SDK 类型及源码核对项目兼容性；清单待单独确认后再更新全局技能，不能仅替换其顶部版本号。
