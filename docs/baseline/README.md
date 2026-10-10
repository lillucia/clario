# Inno 原版验证基线

本基线以原版提交 `fc74cd6a283e8226a4307ea8c3046c715cb6e5f3` 为参照，用于后续改造前后比较。提交、依赖锁文件及来源文件的固定摘要见 [reference.json](reference.json)。验证命令运行的是**当前工作区代码**，不会自动切换或重置到原版提交。

范围是**单用户 Web 应用**：Pi 会话运行时、Inno 扩展、L1/L2/L3、教学入口、工作区与练习、Web 会话、定时任务和打卡。飞书、微信、QQ、企微、Electron 打包和 CLI 交互不列入本轮人工验收；原版代码仍保留。全量测试可能继续检查这些模块的既有测试。

## 执行

使用锁文件对应的依赖，建议固定 **Node 24.x（≥24.15.0）**；本轮使用 **Node 24.19.0、npm 11.6.2**。锁定的 jsdom 要求 `^22.22.2 || ^24.15.0 || >=26`，因此 Node 25.2.1 不满足条件。运行时还需支持 `node:sqlite` 和 FTS5；仅满足项目 `engines` 的最低版本不足以完成基线。

先用已有版本管理器或 PATH 切换到合适的 Node，确认 `node --version` 和 `npm --version`。以下是本轮单 Web 安装与复跑方式；缓存路径可换为本机临时目录：

```sh
node --version
npm --version
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --ignore-scripts --cache /private/tmp/inno-baseline-npm-cache --no-audit --no-fund
npm rebuild node-pty esbuild sharp tree-sitter-bash protobufjs --foreground-scripts
npm run baseline:verify
```

安装使用 `--ignore-scripts`，再显式重建 Web 验证所需模块；Electron 与 computer-use 的安装脚本不在本轮范围。已有兼容且完成重建的依赖时，可直接复跑：

```sh
npm run baseline:verify
```

命令检查锁文件及 SQLite/FTS5，执行基线工具自测、构建、全量 Vitest、L2 检索评估、核心合成 fixture 和真实 HTTP/PTY 检查，输出到被 Git 忽略的 `runtime/baseline/runs/<id>/`。保留该次报告和日志，检查失败项、跳过项及实际执行范围。以报告为准，不能用本文或旧文档中的测试数量代替执行结果。已知问题见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。

2026-09-28 首轮自动验证通过：**96 个测试文件、721 个测试、0 跳过，核心 fixture 11 项、HTTP/PTY 15 项**。真实 provider 教学与浏览器人工验收未执行；详细结果见 [首轮记录](results/2026-09-28.md) 与 [机器可读归档](results/2026-09-28.json)。

2026-10-03 加固脚本后完整复跑通过，原有 721 项测试、6 项工具自测、11 项核心检查和 15 项 HTTP/PTY 检查全部成功；[最终记录](results/2026-10-03.md) 与 [机器可读归档](results/2026-10-03.json) 保存本轮证据。原版应用文件和锁文件未修改。

2026-10-04 使用用户配置的 `deepseek-flash` 跑通一条受控真实模型流程：学习者引导、先修诊断、讲解、作答评分、L2 归档检索、L3 跨会话召回。5 个对话回合完成，25 项数据/trace 核对通过；浏览器也已打开持久化的召回记录。[真实模型记录](results/2026-10-04-live-learning.md) 与 [机器归档](results/2026-10-04-live-learning.json) 保留两处评分/工具归因问题。该流程使用合成学习者和显式工具指令，不等于完整 A1—A7 验收或真实教学效果评估。

随后针对两处问题修改了应用源码：模型工具拒绝未经核验的评分来源，L2 工具明确区分归档审阅事项与实际 lint 结果。修复后全量自动回归通过 **97 个文件、744 个测试、0 跳过**；独立环境的 3 个真实模型回合、20 项程序核对通过。原始验收的 43 份证据摘要保持一致；[修复记录](results/2026-10-04-fixes.md) 和 [机器归档](results/2026-10-04-fixes.json) 单独保存。这是相对原版的首轮改造结果，不能再将当前应用源码称为未修改的原版。

```sh
npm run baseline:prepare
```

此命令生成独立的 Web 验证环境，并打印配置位置和启动方式。按输出启动、打开 Web，先检查页面、设置、会话、文件及非模型接口。默认 dummy provider 不提供模型服务；未配置真实模型时，聊天生成失败是预期结果，不能据此判断教学能力。

启动命令形如 `npm run baseline:web -- --environment <prepare 输出的目录> --port 3100`；该入口使用显式隔离路径，并允许配置后的真实 provider 网络调用。

需要真实模型验收时，由用户在**新环境的配置文件**中填写 provider、model 和凭据，再按 [acceptance.md](acceptance.md) 验收。不要复制个人 `runtime/`、默认 `~/.inno-agent/` 或其密钥；不要把真实凭据写入报告。不要改用省略隔离路径的普通启动命令，以免回到个人数据目录。

## 必须保留的设计与数据约定

此处的“保留”指代码、数据格式、恢复能力和合成样例；建立基线不采集个人数据。

| 范围 | 改造时需要保持的约定 |
| --- | --- |
| Pi 与 Inno 扩展 | Pi 提供 AgentSession、事件和工具循环；Inno 通过工具及扩展注入教学行为。保留事件边界、工具参数与会话恢复契约。 |
| L1 学习者状态 | 学习目标、偏好、知识状态、误解、学习事件与 evidence ID；讲解本身不能作为掌握证据，重试不能重复计分。 |
| L2 知识库 | 原始材料、提取文本、来源 manifest、wiki 页面与 frontmatter、概念及显式先修关系。检索索引可重建，但来源链不能丢。 |
| L3 历史记忆 | 会话 JSONL 是历史来源；索引可重建，保留分段、当前会话排除、相关性门控及删除同步行为。 |
| Web 与工作区 | 会话分支、消息、工作区绑定、附件关联、trace、提问/权限等待状态；保持断线重连、取消与最终历史落盘的约定。 |
| 练习与计划 | 练习文件、运行命令/输出/退出码；任务 cron/时区/prompt、occurrence、运行记录与打卡结果。成功执行与知识掌握分别记录。 |

将来迁移真实数据时，应单独备份上述持久记录并验证恢复；不要将运行中的进程、内存流状态或 SQLite 索引副本当作完整备份。

## 验证证据的边界

自动检查主要验证可重复的程序行为。教学集成测试使用真实 AgentSession 和脚本化 faux provider，证明工具与证据链能够按约定执行；它不证明真实模型会始终选择正确工具或给出优质教学。L2 检索指标只适用于固定 fixture。

自动验证中的 offline 策略只拦截 Node 的全局 `fetch`，允许本地 fixture 请求；它不是操作系统防火墙，也不保证其他 HTTP 客户端或子进程无法联网。数据路径隔离同样不等于操作系统沙箱。

人工验收验证真实 provider 下的工具选择、教学节奏和完整 Web 体验，必须记录模型、输入、实际结果与证据。某次演示成功也不能替代自动回归。未经执行的项目记为“未执行”，禁止补写为“通过”。

当前边界：单进程、单用户；调度器需后端存活；L1 到期复习信息尚不自动生成定时任务；练习输出会进入上下文，但不会自动变为 L1 掌握证据；SSE 重连不等于服务重启后续跑。L3 的 SQLite/FTS5 测试可能因运行时能力不足而跳过，必须显式核对。

## 来源入口

| 内容 | 源码/测试 |
| --- | --- |
| 测试范围与环境 | [vitest.config.ts](../../vitest.config.ts)、[vitest.setup.ts](../../vitest.setup.ts)、[package.json](../../package.json) |
| 教学与 L1 | [teaching-entry-agent.test.ts](../../apps/inno-agent/src/agent/teaching-entry-agent.test.ts)、[learner](../../apps/inno-agent/src/memory/learner) |
| L2 检索 | [eval 脚本](../../scripts/eval-l2-retrieval.ts)、[固定语料](../../apps/inno-agent/eval/l2-retrieval-v1.json)、[L2 测试](../../apps/inno-agent/src/memory/l2) |
| L3 | [l3.test.ts](../../apps/inno-agent/src/memory/l3/l3.test.ts) |
| Web 与流恢复 | [HTTP smoke](../../apps/inno-agent/src/server.smoke.test.ts)、[StreamRegistry 测试](../../apps/inno-agent/src/chat/stream-registry.test.ts)、[ChatStore 测试](../../apps/inno-agent/web/src/stores/chat-store.test.ts) |
| 计划与练习 | [scheduler](../../apps/inno-agent/src/scheduler)、[checkins](../../apps/inno-agent/src/checkins)、[terminal](../../apps/inno-agent/src/terminal) |
