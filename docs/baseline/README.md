# Clario 基线验证

基线验证当前 Clario 工作区，使用 `docs/baseline/reference.json` 固定本项目锁文件及依赖元数据。它不比较其他项目的源码、提交或迁移历史。

## 执行

使用 Node 24.x ≥24.15.0，安装锁文件依赖后执行：

```bash
npm ci
npm run baseline:verify
```

命令检查 Node、SQLite/FTS5、依赖摘要和安装位置，随后执行工具自测、构建、全量 Vitest、L2 检索、核心合成夹具与 HTTP/PTY 检查。输出位于 `runtime/baseline/runs/<id>/`，实际结果以当次报告为准。

升级依赖时，应审查 package.json 和 package-lock.json 的改动，明确更新本项目 reference.json，并重新验证；验证器不会自动接受新锁文件。

## 人工验收

```bash
npm run baseline:prepare
npm run baseline:web -- --environment <prepare 输出的目录> --port 3100
```

准备器创建独立的 learning 配置、合成材料及数据目录。默认 dummy provider 不提供模型服务。需要真实模型时，在该环境配置模型，按 [验收清单](acceptance.md) 操作；不要复制个人配置或凭据。

自动测试证明工程行为，不证明真实模型教学质量。offline 钩子仅限制 Node 全局 fetch，数据路径隔离不等于操作系统沙箱。限制见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。
