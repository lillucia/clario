# Clario 快速开始

```bash
cd ~/Desktop/clario
npm run build
npm start
```

需要 Node 24.15+。当前机器已有独立依赖；换机器时先执行 `npm ci`。

打开 [Clario](http://localhost:3200/)，进入模型设置，填写接口地址、模型 ID 与密钥，然后设置学习目标、选择材料并开始。

配置保存到 `runtime/clario/config/config.json`，学习数据保存到 `runtime/clario/data`，材料与练习在 `workspace/`。原项目的数据不会自动迁入。

更多说明见 [README](README.md)；上游原始快速开始保留在 [docs/upstream/QUICKSTART.md](docs/upstream/QUICKSTART.md)。
