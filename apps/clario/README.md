# Clario 后端

基于 Pi SDK 的学习服务，提供聊天、L1 学习者状态、L2 知识库、L3 历史记忆、工作区、练习运行和学习计划。

## 开发

在仓库根目录使用 Node 24.15+：

```bash
npm ci
npm run build
npm start
```

Web 默认地址为 http://localhost:3200/，配置在 runtime/clario/config/config.json。
需要前端热更新时执行 npm run web:dev；后端修改后重新编译并重启服务。
原始后端入口 npm run server:raw 与 CLI 应显式传入独立配置、数据和工作区路径。

## 源码

- src/server.ts 与 src/server/routes/：HTTP API、SSE 和 WebSocket。
- src/agent/：Pi 会话、教学工具、权限与扩展集成。
- src/memory/：学习者状态、知识库及历史召回。
- src/workspace/ 与 src/terminal/：材料目录、终端和运行记录。
- src/scheduler/ 与 src/checkins/：学习计划及任务执行记录。
- src/config.ts 与 src/runtime.ts：配置、体验开关和路径解析。

默认 learning 模式；渠道、MCP 和完整模式插件仍为可选扩展。当前验证见 [基线说明](../../docs/baseline/README.md)。
