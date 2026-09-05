# 小组件

状态：已实现公共 catalog、服务端 registry、七个内置组件和组件配置校验；天气、日历、图片的服务端适配契约以及应用层连接/资源管理已接入。真实供应商凭据、Google 用户授权和 Kindle 实机证据仍单独验证。

这里按“一种组件，一个文件夹”组织元数据、配置校验、绘制、可选取数和样例。包含 `text`、`date`、`todo`、固定 2×4 的 `codex-usage`、[calendar](src/calendar/README.md)、[weather](src/weather/README.md) 和 [image](src/image/README.md)。

公共入口：

- `@ink-stack/widgets` 导出 `widgetCatalog`、`widgetCatalogByType`、`supportedSizesByWidgetType`、`minimumPixelSizeByWidgetType` 和 `validateWidgetInstanceConfig()`。
- catalog 只包含 manifest、config schema、connection schema 和 defaults，可供前端表单与组件库使用。
- 组件配置校验由 `npm run generate` 在构建期用 Ajv standalone 生成到 `src/generated/config-validators.js`；浏览器运行时不导入 Ajv，也不执行 schema compile。

服务端入口：

- `@ink-stack/widgets/registry.server` 导出 `widgetServerRegistry`、`widgetServerRegistryByType` 和 `renderWidgetToSvg()`。
- registry 只注册项目源码内的受信任 render 函数；渲染函数不取网络、不读凭据、不读系统时间。天气、Google 和图片取数发生在应用服务层，完成后只向 renderer 传脱敏快照。
- Codex 归一化可从 `@ink-stack/widgets/codex-usage/normalize` 导入，输入对齐 `apps/server/src/connectors/codex-app-server.ts` 的 `CodexRateLimitsSnapshot` / `CodexLimitsResult` 结构。

Codex 当前边界：

- `codex-usage` 默认连接引用是 `local-codex-app-server`，默认额度分组是 `codex`。
- 组件只转换和绘制已由后端 connector 读取的官方只读快照，不读取认证文件，不使用普通 OpenAI API key，不创建模型任务，不消费额度重置。
- `observedAt` 必须由 connector 或调用方传入；归一化不会用当前时间伪造采集时间。

组件约定见 [开发约定](../../docs/widgets.md)，目录见 [src](src/README.md)，范围见 [组件清单](../../docs/component-catalog.md)。首期通过显式源码注册组件；加入文件夹后需要注册和重新构建，不支持运行时上传执行。

验证：

```bash
npm run build -w @ink-stack/widgets
npm run test -w @ink-stack/widgets
```
