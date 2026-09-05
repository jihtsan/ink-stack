# 和风天气组件

已实现 manifest、配置与连接 schema、纯 SVG 绘制、取数适配契约、normalize、缓存状态计算及 fixtures。已注册 catalog、服务端渲染器和公共纯绘制入口。尚未接入应用的天气连接管理、实际 HTTP 传输、调度和缓存持久化；未做真实 API 或 Kindle 实机联调。

## 配置与尺寸

- `locationMode` 为 city 或 coordinates；`city` 接受城市名或 Location ID。GeoAPI 有多个候选时提示使用明确 ID 或经纬度，不自动选第一个。
- `latitude/longitude` 为纬度/经度；请求按经度在前并四舍五入到两位小数。支持零值与负值。
- `units=m|i` 分别为 °C、km/h 和 °F、mph，返回值按请求单位标记，不重复换算。
- `title`、`showTemperature/showCondition/showFeelsLike/showHumidity/showWind/showForecast/showUpdatedAt` 控制显示。缺失可选数值显示 —，真实零值仍显示 0。
- `connectionId/connectionRevision` 只引用服务端连接版本；配置拒绝 API Host、JWT、API Key 和秘密引用。
- `refreshSeconds` 默认 900 秒，指定建议采集间隔；此间隔内重复调用可复用仍新鲜的缓存。平台负责调度与并发同键请求合并。
- `cacheTtlSeconds` 默认 1800 秒，从上游 obsTime 起算新鲜期限；达到期限标注过期。
- `maxStaleSeconds` 默认 7200 秒，表示新鲜期限后额外允许保留的时间，0 表示不额外保留。失败不会刷新观测时间。

默认 2×2，支持 2×2/4×2，最小像素区域 220×180。2×2 纵向显示当前天气；4×2 左侧当前天气、右侧三日预报，关闭预报后使用整宽。过往预报按看板时区过滤，无预报显示占位。长中文按可用宽度截断，可选指标最多两行。

正常、过期、无数据、认证失败、连接缺失、位置不明确、超时和数据格式错误都有状态。过期数据强制显示原始观测时间，即使关闭 showUpdatedAt；超出期限隐藏天气数值。渲染依据固定 context.now 重新检查期限，不访问网络、系统时间或文件。署名始终保留 QWeather 和其 URL。

## 服务端接入

导入 `@ink-stack/widgets/weather/server` 的 collectWeather、QWeatherConnection、QWeatherTransport、WeatherCacheEntry。纯转换在 `@ink-stack/widgets/weather/normalize`，类型在 `@ink-stack/widgets/weather/types`。

```ts
const result = await collectWeather({ config, connection, now: job.now, transport, cache: previousEntry, timeoutMs: 8000 });
dataByWidgetId[widget.id] = result.envelope; // 仅 envelope 可进入绘制/预览
// result.cache 只能留在服务端，交给平台保存和复用。
```

连接包含 id/revision/type=qweather、apiHost、authMode=jwt|api-key、secretRef、authRevision、identity。identity 为平台确认的天气项目身份。秘密通过独立写入接口进入加密仓库；connection.schema.json 仅描述引用和专用秘密输入元数据，不接受保存明文 token。

API Host 使用控制台分配的域名，例如 h2a9cf3mhs.xy.qweatherapi.com；不接受协议、端口、用户信息、路径、查询参数、IP 或旧公共 Host。请求固定 HTTPS/GET/允许路径，禁止重定向；响应上限为解压后 256 KiB，总超时默认 8 秒、限制 100–15000ms。

可信 transport 必须实际执行以下职责，组件提供的是调用契约，不是裸 fetch 的安全替代：

- DNS/IP 校验并约束实际连接目标，禁止私有、保留和元数据地址。
- 按 secretRef 读取/解密凭据；缺失或解密失败关闭请求。JWT 使用 Authorization: Bearer，API Key 使用 X-QW-Api-Key。JWT 签发/续期及私钥留在传输层。
- 执行禁止重定向、解压后响应体上限、取消信号和超时。
- HTTP 错误转为 `{ code: String(status) }`；不返回或记录原始错误正文、header、token、秘密 URL。

采集顺序为城市解析、当前天气、可选预报；预报返回错误时保留有效当前天气，总期限超时则回退缓存。缓存键覆盖连接 ID/版本、认证修订、身份、Host、认证模式、秘密引用、地点、单位和预报开关；键本身只留服务端。凭据轮换必须递增 authRevision，身份切换失效旧缓存。上游观测倒退时保留较新的旧快照。

本组件没有后台调度、全局缓存或隐式网络客户端。应用需接线受控传输、连接仓库、计划采集、持久化缓存与同键请求合并。设备 PNG GET 不得调用采集；草稿或连接测试不发布图片。

## 真实 API 联调仍需

1. 和风控制台 API Host、开通 GeoAPI/当前天气/三日预报的项目权限及调用额度。
2. 服务端 API Key 秘密引用，或 JWT 的项目/凭据标识、私钥、签发与刷新实现。
3. 连接 ID/版本、认证修订、稳定来源身份及明确城市 ID 或经纬度。
4. 应用侧受控网络传输、出口规则、连接管理、调度、缓存与 envelope 接线。
5. 实际验证账号权限、单位、时区、认证过期/轮换、限频和缓存隔离；Kindle 型号/固件与真实显示另验。

本版调用 `/geo/v2/city/lookup`、`/v7/weather/now`、`/v7/weather/3d` 和 unit=m|i。官方文档已提示 v7 将弃用，v1 使用不同坐标路径、响应结构及单位约定。部署前确认实际项目仍有 v7 权限；只有 v1 权限时需单独更新适配器与单位转换，不能只改 URL。

官方依据（2026-09-05 核对）：[API Host](https://dev.qweather.com/en/docs/configuration/api-host/)、[认证](https://dev.qweather.com/en/docs/configuration/authentication/)、[城市查询](https://dev.qweather.com/en/docs/api/geoapi/city-lookup/)、[当前天气 v7](https://dev.qweather.com/en/docs/api/weather/weather-now-webapi-v7/)、[逐日预报 v7](https://dev.qweather.com/en/docs/api/weather/weather-daily-forecast-webapi-v7/)、[单位](https://dev.qweather.com/en/docs/resource/unit/)、[署名](https://dev.qweather.com/en/docs/terms/attribution/)。图片显示 QWeather 与 https://www.qweather.com；不打包供应商图标、字体或 SDK。

## 验证与合并

使用 Node 24，从仓库根执行：

```sh
npm run build -w @ink-stack/shared
npm run test -w @ink-stack/widgets
npm run typecheck -w @ink-stack/widgets
npm run build -w @ink-stack/widgets
npm run lint
```

fixtures 中 current/daily/location 为固定模拟供应商响应，states 覆盖正常、过期、超期、空数据、认证失败和超时回退。测试还覆盖恶意配置/Host、经纬度顺序、单位、认证 header、超时取消、秘密边界、缓存轮换、未来/倒退时间、长中文、两个尺寸、多实例与公共模块边界。测试不调用真实 API。

并行合并保留双方 catalog.ts、registry.server.ts、render.ts、catalog.test.ts、scripts/generate-validators.mjs 和 package.json exports 新增条目。生成的 src/generated/config-validators.* 使用 `npm run generate -w @ink-stack/widgets` 重建，不手工拼接。
