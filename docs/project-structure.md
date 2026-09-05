# 文件结构规划

状态：首版软件已实现并进入本地验收（2026-09-05）。下文保留原设计约定；实际交付范围、命令和验证证据以 [验收记录](verification.md) 与 [部署说明](deployment.md) 为准，Kindle 实机仍待验证。

```text
ink-stack/
├── package.json                     # npm workspaces 与根脚本（待创建）
├── package-lock.json                # 预研后锁定依赖（待创建）
├── tsconfig.base.json               # TypeScript 严格模式（待创建）
├── apps/
│   ├── web/
│   │   └── src/
│   │       ├── features/
│   │       │   ├── dashboard-editor/ # 网格画布、选中、拖拽与尺寸调整
│   │       │   ├── widget-library/   # 组件库与添加入口
│   │       │   ├── widget-settings/  # schema 配置表单
│   │       │   ├── data-connections/ # 入口/密钥输入、连接测试和复用
│   │       │   └── publish/          # 实际 PNG 预览、发布与状态
│   │       ├── components/           # 通用按钮、表单等 UI
│   │       └── lib/api.ts            # 管理 API 客户端
│   └── server/
│       ├── migrations/              # SQLite 按版本迁移的 SQL
│       └── src/
│           ├── app.ts               # Fastify 装配，便于 inject 验证
│           ├── index.ts             # HTTP、调度及退出生命周期
│           ├── routes/              # session、catalog、dashboard、preview、publish、display
│           ├── services/
│           │   ├── dashboard.ts     # 草稿、已发布配置和校验
│           │   ├── rendering.ts     # 数据快照、任务调度与线程消息
│           │   ├── render-queue.ts  # 有界队列、合并及修订检查
│           │   ├── publication.ts   # 图片版本发布及 ETag
│           │   └── scheduler.ts     # 已发布看板更新周期
│           ├── workers/
│           │   └── render.worker.ts # 网格区域、SVG/resvg/sharp 绘制
│           ├── connectors/
│           │   └── codex-app-server.ts # 同机 JSON-RPC 连接与超时
│           ├── data/                # 受控请求、凭据与缓存工具
│           │   ├── connections.ts   # 版本化连接、引用及目标校验
│           │   └── credentials.ts   # 秘密加密/解密、轮换与脱敏
│           └── storage/             # better-sqlite3、迁移执行与图片持久化
├── packages/
│   ├── shared/
│   │   └── src/
│   │       ├── dashboard.ts         # 草稿、修订、组件实例契约
│   │       ├── widget.ts            # 元数据、配置、数据状态契约
│   │       ├── screen.ts            # 屏幕与网格规格
│   │       ├── schemas/             # 看板/API 共用 JSON Schema
│   │       ├── grid.ts              # 坐标换算、边界与碰撞纯函数
│   │       └── grid.test.ts         # 网格边界与余数分配验证
│   └── widgets/
│       └── src/
│           ├── catalog.ts           # 前后端可用的纯元数据注册
│           ├── registry.server.ts   # 后端渲染与取数注册
│           ├── _template/           # 新组件开发说明模板
│           ├── text/                # 文字卡片
│           ├── date/                # 日期
│           ├── todo/                # 手动待办
│           ├── codex-usage/         # Codex 额度，2×4
│           ├── weather/             # 天气（后续）
│           ├── calendar/            # 月历及日程（后续）
│           └── image/               # 本地图片（后续）
├── assets/fonts/                    # 经选型及授权确认后的固定字体
├── data/                            # 运行数据，忽略 Git；SQLite、images、tmp
├── devices/kindle/                  # 上游客户端配置与实机记录
└── docs/
    ├── design-v1.md                 # 主规划、阶段与验收
    ├── grid-layout.md               # 网格规则与编辑器设计
    ├── widgets.md                   # 组件开发契约
    ├── component-connections.md     # 入口、密钥、连接复用与测试
    ├── component-catalog.md         # 组件清单与尺寸行为
    ├── project-structure.md         # 本文
    ├── architecture.md              # 技术选型、执行边界、API、发布及验收
    └── roadmap.md                   # 开发进度清单
```

## 为什么这样分

每一种业务组件的元数据、配置、取数、绘制和样例集中在同一目录，方便复制、阅读与扩展。服务端通用数据访问工具仍由平台提供，避免各组件独立维护请求与凭据机制。

apps/web/src/components 存放编辑器通用 UI；packages/widgets/src/<type> 存放墨水屏业务组件，二者不混用。前端只读取组件元数据和配置，不导入其 server.ts。

网格数据和换算逻辑归入已有 packages/shared，暂不另建布局引擎包、插件 SDK 或多服务基础设施。

组件内部文件职责见 [组件开发约定](widgets.md)。已有目录中的 README 会明确“规划中”，避免空目录被误认为完成的组件实现。
