# 后端图片服务

状态：配置、天气、图片资源、Google Calendar OAuth、预览/发布和已发布配置调度已接入；真实供应商授权与 Kindle 长期验收单独记录在 ../../docs/verification.md。

负责配置校验与存储、组件数据获取、服务端渲染、PNG 发布以及 HTTP 缓存校验。

首期约束：

- 输出图片尺寸与目标设备一致。
- 仅在新图片生成成功后替换已发布版本；失败时保留最后一张有效图片。
- 提供稳定的 PNG 地址，并按实际图片内容生成 ETag。
- 将配置管理接口与设备读取接口分开设计，明确各自的访问权限。
- 对远程数据请求设置超时；不允许配置读取服务器内部地址或本地文件。
- 天气仅允许控制台分配的 `*.qweatherapi.com` HTTPS Host，使用 QWeather 当前 v1 经纬度接口；API Key/JWT 只在服务端凭据仓库中加密保存。
- Google OAuth 使用会话绑定 state、固定回调地址和加密 access/refresh token；CalendarList 与 Events 请求有固定页数、条数和响应大小上限。
- 图片只接受 PNG/JPEG/WebP；平台相册写入 `data/images/albums`，登记目录必须是管理员明确提供的绝对路径，上传使用临时文件和原子改名。

在仓库根目录使用 Node 24 执行 `npm ci`、`npm run build`、`npm start`。默认只监听 127.0.0.1:3210，同一个 Fastify 实例提供前端、API、调度和图片。入口为 src/index.ts，API 装配为 src/app.ts，SQLite 迁移在 src/storage/database.ts。

图片存储在 `data/images`；发布指针与配置一起事务提交，预览永不更改发布指针。管理员密码位于 `.local/admin-password.txt`，连接主密钥位于 `.local/master-key.bin`，两者都不能提交到仓库。设备仅使用独立随机 URL 令牌，日志不记录请求路径或请求体。后台调度只处理已发布配置，设备 PNG GET 只服务现有快照/304，不触发上游采集。

主要管理接口包括：`/api/weather-connections`、`/api/image-sources`、`/api/google/status`、`/api/google/oauth/start`、`/api/google/oauth/callback` 和 `/api/schedule`。所有管理接口要求管理员会话；设备地址由 `/api/display-token` 创建或轮换。测试接口可使用未保存天气输入，且不写入连接、草稿或发布表。
