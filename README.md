# 墨栈 · InkStack

用小组件，搭建你的墨水屏。

InkStack 是一个面向墨水屏的可组合信息看板项目。通过网页配置小组件和布局，由服务端生成适合设备分辨率的 PNG，再由 Kindle 定时唤醒、下载并显示。

## 当前状态

首版软件已完成本机开发和验收：React 网格编辑器、Fastify 服务、SQLite 草稿/发布、服务端中文灰度 PNG、四种组件及 Codex 同机只读额度接入均可运行。验证范围和遗留项见 [验收记录](docs/verification.md)。Kindle 实机、固件兼容性与长期续航尚未验证。

## 本地运行

新增 [日历与日程组件](packages/widgets/src/calendar/README.md)：已提供本地月历、日程列表、fixture、公共注册和服务端适配契约。Google OAuth、真实日历读取及专用前端编辑器尚待接入；默认未连接状态不会伪装成授权成功。

编辑器已按 PaperCraft Studio 参考重写为三栏工作台：组件搜索和规格筛选、画布图层、Kindle 设备画框、属性/画布/设备面板，以及编辑与 PNG 预览切换。支持网格显示开关、原始像素比例和 PNG 下载，窄屏下各面板顺序排列。预览按钮会重新生成画面；发布继续使用已保存草稿。视觉和交互验证见 [UI 验收](design-qa.md)。

四款组件采用统一灰阶圆角卡片。日期区分主日期、星期与副标题；待办显示完成数量，支持未完成优先和隐藏项提示；文字即时响应字号、对齐、边框和背景设置。文字、日期和待办在编辑时复用服务端的 SVG 绘制函数及同款中文字体，使用相同的尺寸、换行和截断规则。生成预览后，编辑画布的全部组件直接显示实际 PNG 对应区域，保留选中和拖动操作。修改配置后恢复即时排版，Codex 数据需重新生成预览后同步。网格与选中框只出现在编辑模式。

需要 **Node.js 24 LTS** 和 npm。首次运行：

```powershell
cd F:\ink-stack
npm ci
npm run build
npm start
```

本次开发在 `.tools/node-v24.20.0-win-x64` 放置了独立、已校验的 Node 24，不改变系统 Node。此电脑也可以使用：

```powershell
.\scripts\local.ps1 ci
.\scripts\local.ps1 build
.\scripts\local.ps1 start
```

访问 **http://127.0.0.1:3210**。首次启动生成随机管理员密码，保存在 `.local/admin-password.txt`，不会输出到服务日志。使用该文件中的密码登录；也可通过 `INKSTACK_ADMIN_PASSWORD` 环境变量提供至少 16 字符的密码。不要提交 `.local` 或 `data`。

添加组件 → 配置和移动 → 保存草稿 → 预览 → 发布。预览使用服务端实际 PNG。首次“创建图片地址”返回独立只读地址，原文只显示一次；重新生成将使旧地址失效。页面刷新后仍可查看发布状态，但不会回传旧令牌。

```powershell
npm run typecheck
npm test
npm run lint
npm run build
```

`npm test` 会先构建工作区及真实渲染线程，再运行测试。`npm run lint` 检查浏览器/服务端导入边界；严格类型检查是主要静态分析门禁。`npm run dev` 构建后启动同一个后端，无额外常驻基础设施。

## 产品方向

- 在列数×行数网格中添加、配置和排列小组件，按组件支持的尺寸吸附放置。
- 每种组件集中在独立文件夹，支持同类型的多个实例。
- 通过统一的组件接口扩展天气、日历、待办和自定义数据。
- 预览设备实际尺寸的画面，并发布为 PNG。
- 支持已有图片的缓存校验，减少不必要的下载和墨水屏刷新。
- 首先对接已越狱 Kindle 的 kndl-online-screensaver，后续扩展其他墨水屏。

## 工作方式

```text
网页配置台 → 后端配置与数据服务 → 组件渲染 → PNG 图片地址
                                                 ↓
                                   Kindle 定时唤醒并下载
                                                 ↓
                                         显示画面并休眠
```

图片生成服务与 Kindle 的刷新周期分别管理。Kindle 端的休眠和定时唤醒由设备客户端负责。

## 目录

| 目录 | 职责 |
| --- | --- |
| [apps/web](apps/web/README.md) | 网页配置台和画面预览 |
| [apps/server](apps/server/README.md) | 配置存储、数据获取、图片生成和分发 |
| [packages/widgets](packages/widgets/README.md) | 小组件定义、配置与渲染 |
| [packages/shared](packages/shared/README.md) | 共享的数据契约 |
| [devices/kindle](devices/kindle/README.md) | Kindle 客户端接入说明 |
| [docs](docs/architecture.md) | 架构、组件约定和开发路线 |

## 开发入口

1. 阅读 [第一版设计](docs/design-v1.md)、[技术架构](docs/architecture.md) 和 [网格设计](docs/grid-layout.md)。
2. 查看 [组件清单](docs/component-catalog.md)、[组件开发约定](docs/widgets.md) 和 [文件结构](docs/project-structure.md)。
3. 按 [开发路线](docs/roadmap.md) 完成首个端到端版本。

已采用技术栈：TypeScript 严格模式 + npm workspaces；React/Vite 配置台；Node.js 24 LTS/Fastify 服务端；SQLite/better-sqlite3 存储；SVG/resvg/sharp 输出 PNG。Codex 额度通过同机 App Server 只读采集，首版组件占 2 列 × 4 行。

精确依赖见 package-lock.json。固定 Noto Sans CJK SC 字体及 OFL 许可在 assets/fonts。仓库不包含第三方 Kindle 客户端代码或二进制。部署、备份与连接限制见 [本地部署](docs/deployment.md)。

## Kindle 接入

初期使用 [kndl-online-screensaver](https://codeberg.org/cryptomilk/kndl-online-screensaver) 从 InkStack 提供的图片地址获取 PNG。该客户端有独立的机型、固件、KUAL 和 linkss 要求，详见 [接入说明](devices/kindle/README.md)。

## 项目状态约定

文档中的“计划”“草案”和路线图均表示待实现能力。功能完成后，应同时更新使用说明及对应验证结果。
