# Clario 系统依赖

## 本机 Web

- Node 24.15+，推荐 24.19；需要 node:sqlite 和 SQLite FTS5。
- npm 工作区依赖由根 package-lock.json 固定。
- node-pty 提供练习终端；目标平台没有预编译文件时，需要 Python 3、make 和 C/C++ 编译器。
- Python 3 用于 `apps/clario/scripts/pptx_to_svg` 的 PPTX 预览转换。
- 科学计算库、Pandoc、浏览器或其他练习工具按具体材料安装，并非全部为 Clario 启动必需。

标准 npm start 使用 `runtime/clario/config/`、`runtime/clario/data/`、`runtime/clario/skills/` 与根 workspace/，默认端口 3200。

## Docker

Dockerfile 包含构建与 Web 运行阶段；Dockerfile.base 提供可选的学习工具环境。docker-compose.yml 提供本地部署入口。容器默认服务端口为 3000。

当前 Docker 环境通过兼容变量设置 `/etc/clario` 配置、`/var/lib/clario` 数据和 `/srv/clario-workspace` 工作区。以仓库 Dockerfile 和 compose 配置为准；容器部署不等同于模型工具沙箱。

## 可选扩展

完整模式的渠道、MCP、子代理、网页访问和本机 GUI 控制有各自的依赖及权限要求；learning 模式关闭这些扩展。GUI 控制需要显式启用，macOS 还需要辅助功能与屏幕录制权限。

权限与沙箱见 [PERMISSIONS_AND_SANDBOX.md](PERMISSIONS_AND_SANDBOX.md)，安装启动见 [项目 README](../README.md)。
