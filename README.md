# Clario

Clario 是独立的 Web 学习工作区，基于 Pi SDK 提供对话学习、学习状态、知识库、跨会话记忆、技能管理、学习计划及工作区练习。

## 启动

使用 Node 24.15+（已验证 24.19）：

```bash
npm ci
npm run build
npm start
```

打开 [http://localhost:3200/](http://localhost:3200/)。可用 `npm start -- --port 3202` 修改端口。
首次启动生成 `runtime/clario/config/config.json`。在页面模型设置中填写接口地址、模型 ID 和密钥，然后在聊天中描述学习目标、加入材料。

## 项目结构

- `apps/clario/`：后端、教学工具及 L1/L2/L3 记忆。
- `apps/clario/web/`：学习工作区前端。
- `apps/showcase/`：独立的案例回放站。
- `runtime/clario/`：本机配置、会话、知识库及学习状态；不提交 Git。
- `workspace/`：学习材料和练习文件；不提交 Git。
- `docs/`：Clario 的体验、架构、权限和验证说明。

## 开发与验证

```bash
npm test
npm run baseline:verify
npm run showcase:build
```

基线校验 Clario 自身锁文件及安装依赖，执行构建、测试、L2 检索、核心学习夹具和 HTTP/PTY 检查。报告保存到 `runtime/baseline/runs/`。

默认 `experience: "learning"`。`full` 是可选的扩展模式，用于开启渠道、MCP 和其他扩展。Web、CLI、Docker 与 showcase 入口保留；Electron 已移除。
标准启动器显式使用本项目数据路径。内部 `INNO_*` 环境变量及部分标识暂时保持兼容；高级 CLI 和原始服务入口应显式指定运行路径。

[快速开始](QUICKSTART.md) · [学习体验](docs/web-learning.md) · [基线验证](docs/baseline/README.md) · [权限与沙箱](docs/PERMISSIONS_AND_SANDBOX.md) · [系统依赖](docs/SYSTEM_DEPENDENCIES.md)

