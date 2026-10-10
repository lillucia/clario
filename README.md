# Clario

一个聚焦 Web 的学习工作区：从对话明确目标，在聊天框加入材料，随后查看练习结果与学习状态。详细学习目标可在学习者面板补充。

本项目从已改造的 Inno 工作区独立迁移，沿用 Pi SDK、原教学入口、L1 学习者状态、L2 知识库、L3 会话记忆和练习运行能力。它具有独立目录、npm 工作区、Git 仓库、界面品牌与运行数据路径。原项目不受影响。

## 启动

使用 **Node 24.15+（已验证 24.19）**。依赖由锁文件固定；安装与启动：

```bash
cd ~/Desktop/clario
npm ci
npm run build
npm start
```

打开 [http://localhost:3200/](http://localhost:3200/)。默认端口 3200，与原验收环境 3100/3101 分开；可用 `npm start -- --port 3202` 修改。

首次启动生成 `runtime/clario/config/config.json`。示例配置没有真实密钥，请在页面的模型设置中填写兼容接口地址、模型 ID 与密钥后再开始学习。原项目的配置、学习记录和工作区文件未复制。

## 结构与验证

- `apps/clario/`：后端、教学工具与三层记忆。
- `apps/clario/web/`：学习入口与 Web 界面。
- `workspace/`：本项目的学习材料及练习文件，首次启动创建。
- `runtime/clario/`：本项目独立配置、会话、知识库、学习状态和运行记录；已忽略提交。
- `docs/migration/source-manifest.json`：611 项来源文件及 SHA-256，包含迁移前未提交的代码改造。

```bash
npm test
npm run baseline:verify
```

[Pi 0.99.2 同步说明](docs/upgrades/pi-0.99.2.md) · [迁移说明](MIGRATION.md) · [学习模式说明](docs/web-learning.md) · [上游参考文档](docs/upstream/README.zh-CN.md)

## 保留与回退

默认 `experience: "learning"`，渠道、桌面入口和复杂扩展关闭，源码保留。改为 `"full"` 并重启可恢复完整功能模式；这不等同于恢复上游原版源码。

内部 `INNO_*` 环境键、CSS 类、工具名及数据契约部分保留兼容。标准 `npm start` 会显式使用本项目的全部数据路径，忽略继承的旧项目运行路径。高级 `npm run server:raw` 与 `npm run cli` 应自行传入独立路径。

Electron、Docker、showcase 源码随项目保留；桌面签名配置仍是上游参考，需要另行配置自己的签名身份，未作为本轮桌面发布能力验收。

## 来源与许可

源项目为 Inno Agent，原作者为 Inno Agent Contributors，采用 MIT 许可。原 [LICENSE](LICENSE) 及版权声明完整保留。历史 `docs/baseline/` 报告描述的是原项目当时的运行，不是新项目验收结论；原运行证据仍在 `/Users/lili/Desktop/inno-agent/runtime/`，没有迁入新项目。
