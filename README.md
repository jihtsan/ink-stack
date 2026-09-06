# 墨栈 · InkStack

用小组件，搭建你的墨水屏。

InkStack 是一个面向墨水屏的可组合信息看板项目。通过网页配置小组件和布局，由服务端生成适合设备分辨率的 PNG，再由 Kindle 定时唤醒、下载并显示。

## 当前状态

首版工作流已接通：React 网格编辑器、Fastify 服务、SQLite 草稿/发布、服务端中文灰度 PNG、七种内置组件、服务端天气连接、图片资源管理、Google OAuth/Calendar 接口和已发布配置调度均可运行。和风天气与 Google 的真实账号联调需要在本机配置供应商凭据；代码集成使用受控模拟上游验证，不能替代供应商授权。Kindle 已完成 linkss 安装与首次显示确认，连续唤醒、断网恢复和长期续航仍待实机验证，详见 [验收记录](docs/verification.md)。

## 本地运行

已加入 [日历与日程组件](packages/widgets/src/calendar/README.md)、[和风天气组件](packages/widgets/src/weather/README.md) 和 [图片/相册组件](packages/widgets/src/image/README.md)：公共 catalog、服务端 registry、配置校验、纯 SVG 绘制、服务端连接/资源管理和编辑器配置面板均已接入。默认未连接状态不会伪装成授权成功；真实天气请求需要 QWeather 控制台分配的 API Host 与密钥，真实 Google 日程需要 OAuth Web 应用和用户授权。

编辑器已按 PaperCraft Studio 参考重写为三栏工作台：组件搜索和规格筛选、画布图层、Kindle 设备画框、属性/画布/设备面板，以及编辑与 PNG 预览切换。支持网格显示开关、原始像素比例和 PNG 下载，窄屏下各面板顺序排列。预览按钮会重新生成画面；发布继续使用已保存草稿。视觉和交互验证见 [UI 验收](design-qa.md)。

七款组件采用统一灰阶圆角卡片。日期区分主日期、星期与副标题；待办显示完成数量，支持未完成优先和隐藏项提示；文字即时响应字号、对齐、边框和背景设置。天气、日历、图片在编辑器中使用与服务端相同的纯 SVG 绘制函数；图片预览在没有服务端资源快照时明确显示不可用状态。生成预览后，编辑画布的全部组件直接显示实际 PNG 对应区域，保留选中和拖动操作。修改配置后恢复即时排版，数据型组件需重新生成预览后同步。网格与选中框只出现在编辑模式。

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

访问 **http://127.0.0.1:3210**。首次启动生成随机管理员密码，保存在 `.local/admin-password.txt`，不会输出到服务日志；同时生成 `.local/master-key.bin`，用于连接密钥加密，必须和数据目录一起备份但不要提交。使用该文件中的密码登录；也可通过 `INKSTACK_ADMIN_PASSWORD` 环境变量提供至少 16 字符的密码。不要提交 `.local` 或 `data`。`INKSTACK_REFRESH_SECONDS` 仅在显式设置时覆盖初始调度周期，未设置时重启会保留页面保存的周期。

添加组件 → 配置和移动 → 自动预览或手动预览 → 一键发布。预览使用服务端实际 PNG；发布会自动保存当前有效草稿，并只替换成功生成的已发布快照。天气连接密钥只在服务端加密保存，图片面板可登记相册/管理员目录、扫描和上传图片，日历面板通过 Google OAuth 读取可用日历。首次“创建图片地址”返回独立只读地址，原文只显示一次；重新生成将使旧地址失效。页面刷新后仍可查看发布状态，但不会回传旧令牌。

### 外部连接配置

- 和风天气：在天气面板填写控制台分配的 API Host 和 API Key/JWT；服务端调用当前 v1 经纬度天气，并可按面板选择逐日、逐小时或空气质量扩展信息，城市名先经过 GeoAPI 唯一匹配。测试未保存输入时不会写入连接或发布配置。
- Google Calendar：在日历面板保存 OAuth Web 应用 Client ID/Secret，把页面显示的精确 `/api/google/oauth/callback` 加入 Google Cloud Console，然后点击“连接 Google”。授权 token 只留在服务端。
- 图片：平台相册写入 `data/images/albums`；服务器目录必须由管理员登记，浏览器不会读取任意服务器路径，也不支持远程 URL。

后台刷新只采集并重新生成已发布配置；Kindle 客户端按设备自身日程 GET 固定图片地址。图片 GET 不触发上游采集，也不能代表 Kindle 已经完成屏幕显示。

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

### PaperCraft 组件样式

天气综合看板支持 24 小时温度、未来五天、AQI/PM2.5、UV 模块开关，线框/点阵/实体图标及服务端 16 级灰度抖动，提供 1/2/6 小时采集预设。日历和 Codex 新增 2×2 尺寸；照片支持相纸边框和自定义题字。日期可放在顶部，不提供时钟、电量或耗电估算。

旧看板布局和连接引用保持兼容；已有天气可在「天气看板样式」切换「24H + 5 天综合看板」。数据更新时间、日程时间和额度重置时间作为数据含义保留。衣着参考根据当前天气简单估计；暴雨触发 Kindle 消残影未接入，详见 [设计适配与验证](docs/stitch-components.md)。
