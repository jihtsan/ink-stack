# 共享协议

状态：已实现首版共享契约与纯网格逻辑。

本包发布为 `@ink-stack/shared`，面向前端和服务端导出公开、安全的 dashboard/grid/widget 契约，不包含密钥、服务端内部状态或任意 metadata 字段。

主要导出：

- `DashboardDraft`、`WidgetInstance`、`GridSpec`、`ScreenSpec`。
- `createDefaultDashboard()`，默认 600×800、4×6 网格、空画布。
- `validateDashboard()` / `validateDashboardDraft()`，先跑 Draft 7 schema，再跑时区、边界、碰撞、尺寸和最小像素区域校验。
- `computePixelRect()`、`snapPointerToGrid()`、`findFirstAvailablePlacement()`、`validateDashboardLayout()`。
- `DashboardRenderInput`，服务端渲染任务使用同一份 dashboard、固定 `now`、每实例数据快照和字体族。

约束：

- 屏幕单边最大 2048px。
- 主题颜色只接受 `#RRGGBB`，避免 SVG 注入。
- 时区用 `Intl.DateTimeFormat` 验证。
- 组件位置只保存整数网格坐标和跨度；像素矩形由共享函数计算。
- 当前最小组件渲染区域为 60×40px。
- Draft 7 schema 存在 `src/schemas/dashboard.schema.json`；`npm run generate` 使用 Ajv standalone 生成 `src/generated/validators.js`，浏览器运行时不调用 `ajv.compile()`，也不需要 CSP `unsafe-eval`。

验证：

```bash
npm run build -w @ink-stack/shared
npm run test -w @ink-stack/shared
```
