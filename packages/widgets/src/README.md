# 组件目录

状态：首版组件已实现并通过包级构建与测试。

| 目录 | 用途 | 阶段 |
| --- | --- | --- |
| [_template](_template/README.md) | 开发新组件的说明模板 | 模板，不注册 |
| [text](text/README.md) | 文字卡片 | 首版已实现 |
| [date](date/README.md) | 日期 | 首版已实现 |
| [todo](todo/README.md) | 手动待办 | 首版已实现 |
| [codex-usage](codex-usage/README.md) | Codex 额度，2 列 × 4 行 | 首版已实现；真实读取证据见集成文档 |
| [weather](weather/README.md) | 天气 | 组件与 QWeather v1/v7 兼容适配契约已实现；应用层提供受控连接和测试入口 |
| [calendar](calendar/README.md) | 月历与日程 | 绘制、Google 事件适配与应用层 OAuth 接线已实现；真实用户授权需部署配置 |
| [image](image/README.md) | 本地图片 | 组件、受控目录扫描、轮换、应用层相册管理和上传已实现 |

当前公共入口是 `catalog.ts`，仅暴露 manifest、schema、defaults 和像素约束；服务端入口是 `registry.server.ts`，仅暴露受信任的 SVG render 函数。文件约定见 [组件开发文档](../../../docs/widgets.md)。
