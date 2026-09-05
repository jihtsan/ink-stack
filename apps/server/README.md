# 后端图片服务

状态：首版服务已实现，测试及设备验收范围见 ../../docs/verification.md。

负责配置校验与存储、组件数据获取、服务端渲染、PNG 发布以及 HTTP 缓存校验。

首期约束：

- 输出图片尺寸与目标设备一致。
- 仅在新图片生成成功后替换已发布版本；失败时保留最后一张有效图片。
- 提供稳定的 PNG 地址，并按实际图片内容生成 ETag。
- 将配置管理接口与设备读取接口分开设计，明确各自的访问权限。
- 对远程数据请求设置超时；不允许配置读取服务器内部地址或本地文件。

在仓库根目录使用 Node 24 执行 `npm ci`、`npm run build`、`npm start`。默认只监听 127.0.0.1:3210，同一个 Fastify 实例提供前端、API、调度和图片。入口为 src/index.ts，API 装配为 src/app.ts，SQLite 迁移在 src/storage/database.ts。

图片存储在 data/images；发布指针与配置一起事务提交，预览永不更改发布指针。管理员密码位于 .local/admin-password.txt，设备仅使用独立随机 URL 令牌，日志不记录请求路径或请求体。连接当前仅支持 codex-local，不支持任意 URL 或以 API key 代替 Codex 登录。
