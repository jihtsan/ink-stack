# 日历与日程 · calendar

状态：本地月历、日程列表、配置校验、fixture 和服务端适配契约已实现。**真实 Google OAuth、日历列表读取和事件 HTTP 请求尚未实现**。默认显示本地月历和“未连接 Google Calendar”；任意连接 ID 不代表授权成功，未注入 adapter 时显示“Google 授权接入尚未完成”。

## 文件与入口

- manifest/schema/defaults/connection schema：公共定义，显式加入 catalog 和生成式校验。
- `model.ts`：当地日期、范围、事件契约；全天事件结束日期不包含在事件内。
- `render.ts`：纯 SVG，只使用输入时间、看板时区和快照；从 `@ink-stack/widgets/render` 导出。
- `server.ts`：适配器、超时、状态与 Google 字段归一化，仅从 `@ink-stack/widgets/calendar/server` 导出。
- `fixtures/`：固定在 `2026-09-05T00:00:00Z` 的示例、空日程、授权失效数据。模拟图标明“示例数据”；生产不自动载入。
- `calendar.test.ts`：配置、日期、尺寸、状态、转义、重复实例及数据边界测试。

## 配置与尺寸

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| title | 日历 | 最多 40 字符 |
| layout | month | month、list、month-list |
| month | 空字符串 | 当前月，或指定 2000-01 至 2099-12；不影响独立列表 |
| weekStartsOn / showWeekdays | 1 / true | 周一（1）或周日（0）开始；显示周标题 |
| connectionId / connectionRevision | 空 / 1 | 服务端连接版本引用，禁止 token、密码、密钥和私有 URL |
| calendarIds | `["primary"]` | 1–5 个不重复日历 ID；未来从已授权日历列表选择 |
| eventRangeDays | 7 | 独立列表从当地今天起 1–31 个日历日，包含当天已结束事件 |
| maxVisible | 5 | 列表最多 1–20 项，受区域限制，多余事件显示数量 |

支持 4×2、4×3（默认）、4×4；最小像素区域 320×210。月历固定六周，黑底突出今天，下划线标记事件。月历获取完整显示月，含跨月重叠事件；month-list 摘要使用相同月范围。短卡片保留月历并提示切换列表，足够高时追加摘要。中文长标题按宽度省略，沿用平台字体，不额外打包字体。

## 服务端契约

`CalendarAdapter.read(request, signal)` 接收连接 ID/版本、日历 ID、IANA 时区、startDate（包含）/endDate（不包含）及最大 100 条事件限制。未来 HTTP adapter 必须按时区把当地日期转换为 RFC3339 零点，正确处理夏令时，不能添加固定 UTC 偏移。

返回 `{ source: "google" | "fixture", observedAt, events, truncated }`。事件仅含 id、calendarId、title、allDay、start、end。全天为 YYYY-MM-DD，定时事件必须携带 UTC 偏移。当天先显示全天事件，再按开始时间排序。Google 重复事件需使用 singleEvents=true 展开；归一化器跳过取消事件，不转发描述、与会者、账号或原始响应。

默认超时 5 秒，同时终止 signal 和等待。10 分钟内 fresh，10–60 分钟 stale 并显示原始更新时间，超过 60 分钟丢弃事件。渲染也检查年龄；授权失败不复用旧数据。组件自身不缓存、不调度后台请求、不去重；collectWidgetData 接收可选 adapter，日历实例依次采集。未来缓存按连接版本、认证修订、实际账号、日历和范围隔离；账号切换时失效。

未连接、授权失效、读取失败与成功获取零条分别显示，月历仍可用。平台继续负责 PNG 发布和失败保留策略。

## 真实 Google 接入 TODO

1. 管理员会话下的 OAuth 发起/回调、会话绑定 state、固定 redirect URI、授权码交换、撤销/重连。当前 connection schema 仅描述流程，没有授权路由。
2. 客户端密钥、access/refresh token 仅服务端加密保存及刷新；连接版本绑定账号，秘密不进入看板、日志、浏览器 GET 或渲染消息。
3. 请求 calendar.events.readonly 与 calendar.calendarlist.readonly，读取分页的已授权日历列表并实现专用连接/日历选择编辑器。主 UI 的硬编码组件类型分支仍需集成。
4. 受限 Google HTTPS adapter：固定 API 目标、禁止重定向泄漏凭据、响应体/并发/页数限制；events.list 使用 singleEvents=true、orderBy=startTime、showDeleted=false。处理分页、重复项、401/403、限流和刷新失败，截断必须返回 truncated=true。
5. 将 adapter 注入 collectWidgetData 与平台周期采集。真实 Google、授权撤销/账号切换、平台端到端及 Kindle 实机尚未验证。

官方依据：[Events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)、[事件资源](https://developers.google.com/workspace/calendar/api/v3/reference/events)、[CalendarList.list](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list)、[Web Server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)。

## 验证

仓库根目录使用 Node 24：

```sh
npm run build -w @ink-stack/shared
npm run test -w @ink-stack/widgets
npm run build -w @ink-stack/widgets
npx vitest run apps/server/src/services/widget-data.test.ts
npm run typecheck
npm run lint
```

测试 fixture 必须使用非空测试连接引用和固定时间。运行中的主程序未注入 Google adapter，不发起真实授权或 Google 请求。
