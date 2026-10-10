# 知序迁移后的验证口径

新项目沿用原来的自动检查流程：使用兼容的 Node 版本安装依赖后，运行 `npm run baseline:verify`。报告写入新项目自己的 `runtime/baseline/runs/`，不会覆盖旧项目运行记录。

## 原版证据与本次迁移

- `docs/baseline/reference.json` 和 `docs/baseline/results/` 保留迁移时的原始字节，属于 Inno 的历史证据。报告中的旧路径、旧项目名和旧绝对路径不作改写；这些历史报告不等于知序的新验收结果。
- `docs/migration/source-manifest.json` 记录复制来源、原工作区文件指纹、迁移路径和锁文件 SHA。原项目包含尚未提交的 Web 学习改动；它不是纯净的上游提交快照。
- 新项目检查原版文件时，按 `pathMappings` 将 `apps/inno-agent` 定位到 `apps/zhixu`。缺失与修改仍按原路径列出；新增应用文件按新路径列出。改名不会把整个应用误报为缺失，也不会隐藏功能差异。
- 新 Git 仓库尚无提交时，报告中 `currentCommit` 为 `uncommitted`，不冒用原项目提交作为新项目提交。

## 锁文件与外部依赖

项目及工作区改名导致 `package-lock.json` 的字节变化，因此新检查名为 `lockfile-migration-pinned`，核对迁移清单里的 `targetLockfileSha256`，不再声称原锁文件完全未变。

`dependency-lock-reference.json` 在核对原锁文件 SHA 后生成，固定原锁文件中所有非工作区链接的外部包元数据及本地工作区依赖声明。生成与检查均按迁移映射规范化目录前缀，对 JSON 对象键排序后计算 SHA-256；数组顺序保留。项目名与工作区链接可改名，外部包版本、下载地址、完整性信息及其他包元数据均需保持一致。新检查名为 `external-dependencies-unchanged`。

`historical-evidence-preserved` 另行检查原版指纹文件与历史验收报告是否与复制时一致。任何后续合法依赖升级都应作为新的改动说明并更新迁移后的锁定策略，不能通过改写原历史报告消除差异。

自动检查通过只表示当前代码在指定环境中完成构建、测试、L2 检索评估、核心与 HTTP/PTY 合成验证，不代表本次迁移已经重新完成真实模型教学验收。
