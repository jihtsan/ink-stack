# 网页配置台

状态：编辑器已按 Stitch PaperCraft Studio 参考重写，并通过本地独立数据环境的浏览器流程验证，见 [UI 验收](../../design-qa.md)。

负责设备尺寸和网格配置、小组件库、吸附拖拽、尺寸选择、参数编辑、画面预览和发布操作。

## 本地命令

```bash
npm run dev -w @ink-stack/web
npm run typecheck -w @ink-stack/web
npm run test -w @ink-stack/web
npm run build -w @ink-stack/web
```

Vite 默认监听 `http://127.0.0.1:5173`，当前没有 API 代理。完整功能请在仓库根目录运行 `npm run build` 和 `npm start`，由后端同源提供 `apps/web/dist` 和 API。

## 已实现

- 三栏编辑器：独立圆角组件卡片、Kindle 设备画框、属性/画布/设备面板；窄屏顺序排列。
- 组件搜索、分类/尺寸筛选、画布图层选择、网格显示开关、适应窗口和原始像素比例。
- 编辑与实际 PNG 预览切换、强制重新生成预览、下载预览/已发布 PNG；PNG 模式不响应布局编辑快捷键。
- 本地托管 Google Material Symbols 图标及 Apache 2.0 许可，无新增 npm 依赖。
- 首版组件：文字、日期、手动待办、固定 `2 x 4` 的 Codex 额度，以及日历、天气、图片。
- 日历、天气、图片的编辑器面板只保存连接/资源引用和显示选项；OAuth、天气密钥、相册目录权限由服务端平台管理。
- 网格行为：整数坐标、吸附拖动、键盘方向键、位置表单、离散尺寸、复制、删除、当前会话撤销。
- 非法布局：越界、重叠和不支持尺寸在前端回退，不隐式挤开其他组件。
- 草稿/预览/发布：通过 `src/api.ts` 调用服务端 API；预览 job 绑定 `editorRevision`，旧响应不会覆盖新编辑。
- 登录：使用 `/api/session`，依赖后端 HttpOnly cookie。
- Codex 连接：只支持 `codex-local`，可创建、选择、测试、刷新和选择额度组；不提供普通 OpenAI API key 或任意 URL 输入。
- 图片地址：仅在创建或轮换 token 时显示服务端返回的稳定 URL。

## 验证与限制

- 本轮已验证独立本地服务上的组件编辑、保存、预览和发布，以及桌面/手机布局。没有修改现有设备的看板配置或图片地址。
- 当前前端不把模拟额度视为真实数据；Codex 额度必须以后端实际读取结果展示。
- Kindle 实机刷新与续航需要设备证据，本包不宣称通过。
