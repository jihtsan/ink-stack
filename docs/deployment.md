# 本地部署与恢复

验证平台：Windows x64、Node 24.20.0。其他 CPU、NAS、容器及 Kindle 尚需目标平台验证。只运行一个 SQLite 写入实例。

## 启动配置

在仓库根目录运行 `npm ci && npm run build && npm start`（PowerShell 旧版本逐条运行）。服务需要保留 packages 的构建产物、apps/server/dist、apps/web/dist、assets/fonts 和生产依赖。构建 JSON 资源由 tsc 的 resolveJsonModule 复制。

锁定 better-sqlite3 12.11.1，已通过 Node 24.20.0 的 Windows x64 预编译安装和 `npm ci`。13.0.3 在本机干净安装时意外触发 node-gyp，因此未采用。安装前停止此项目服务及测试，避免 Windows 占用原生 `.node` 文件。其他平台若没有对应预编译包，仍需按上游要求安装原生编译工具。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| HOST | 127.0.0.1 | 默认仅本机，不自动公开 |
| PORT | 3210 | HTTP 端口 |
| INKSTACK_ORIGIN | http://HOST:PORT | 管理界面精确来源，变更请求校验 Origin |
| INKSTACK_DATA_DIR | data | SQLite 与 PNG 目录 |
| INKSTACK_ADMIN_PASSWORD | 自动生成本地文件 | 至少16字符；服务器用 scrypt 比较 |
| INKSTACK_REFRESH_SECONDS | 首次启动900秒；之后使用数据库值 | 覆盖已发布配置更新周期，范围60—86400秒；未设置时保留网页中保存的值 |
| INKSTACK_CODEX_COMMAND | PATH 上的 Codex 可执行文件 | 可固定真实二进制绝对路径，不能来自网页配置 |
| INKSTACK_MASTER_KEY | `.local/master-key.bin` 自动生成 | 可用32字节 base64url 值注入；用于天气密钥、Google OAuth 客户端和令牌加密 |

管理员密码文件 `.local/admin-password.txt` 不属于备份数据库。登录 cookie 为 HttpOnly、SameSite=Strict，HTTPS origin 下启用 Secure；会话最长12小时，重启后重新登录。`.local` 应只允许服务账号读取。Windows 可按服务账号设置目录 ACL，POSIX 启动时使用700目录/600文件。

Kindle 接入时需选择可信局域网地址，将 HOST 设为该接口地址，并把 INKSTACK_ORIGIN 设为浏览器实际访问的精确地址。本次实机联调使用 `HOST=192.168.100.116`、`PORT=3210`、`INKSTACK_ORIGIN=http://192.168.100.116:3210`，只监听该私网接口；没有绑定 `0.0.0.0`、添加防火墙规则或配置公网转发。HTTP 不提供传输保密；公网部署不在已验证范围。主机地址变化后应重新生成 Kindle 配置。

## 受控连接

所有外部连接都由服务端登记和读取。浏览器只提交连接配置或资源引用，不保存密钥、OAuth token，也不接受任意上游 URL。缺少主密钥时，写入需要加密的凭据会被拒绝。

### Codex

服务账号必须具备同机 Codex CLI 和 ChatGPT 登录环境，命令通过固定服务部署配置/PATH 解析，以 shell:false 启动。只读取 account/read 和 account/rateLimits/read，不读取或复制认证文件，不发模型任务，不使用 API key，不消费 reset。

默认每10分钟复用一次最小快照；手动测试至少间隔15秒且限频。多个本机连接代表同一个主机来源，复用采集，不能绑定不同账号。登录失效清除旧快照；短暂读取失败且确认仍是同一账号时，一小时内显示过期值及原采集时间，超过一小时隐藏值。身份未知或切换时不复用余额。重启后先重新读取，不伪造缓存。

Codex 适配器只允许本机只读命令，不能从网页配置 API key、订阅 URL 或任意命令。未声明的秘密/入口一律拒绝；不发模型任务、不读取认证文件、不消费 reset。

### QWeather

天气连接使用 QWeather v1 的当前天气、逐日预报、逐小时预报、空气质量和城市查找接口；服务端只允许 HTTPS、固定 API 路径及固定查询参数，并将 API key 保存在加密凭据仓库。接口形态以 [QWeather 当前天气 v1 文档](https://dev.qweather.com/docs/api/weather/weather-current/)、[逐日预报 v1 文档](https://dev.qweather.com/docs/api/weather/weather-daily-forecast/)、[逐小时预报 v1 文档](https://dev.qweather.com/docs/api/weather/weather-hourly-forecast/)、[空气质量实时数据文档](https://dev.qweather.com/en/docs/api/air-quality/air-current/) 和 [城市查找文档](https://dev.qweather.com/docs/api/geoapi/city-lookup/) 为准。未保存的连接测试只验证输入和上游返回，不写入连接、缓存或发布任务。

部署者需要在管理页提供官方 API Host 与密钥，并确认该 Host 属于自己的 QWeather 服务配置；本地模拟 transport 和单元测试不等同于真实供应商联调。

### Google Calendar

先在管理页保存 Google OAuth Web 客户端的 client ID/secret，再使用页面显示的精确回调地址发起授权。服务端通过会话绑定的 state 完成回调，access/refresh token 加密保存，并按需读取 CalendarList 和 Events；未完成 Google Cloud 客户端配置或用户授权时，不应把模拟 OAuth 测试当成真实接入证据。

### 调度

调度状态和刷新周期持久化在 SQLite。首次初始化为启用、900秒；网页保存的启用状态和60—86400秒周期会跨重启保留。每次自动任务只读取已发布修订，不会把未发布草稿推送到设备；取图 URL 只读取已发布 PNG，不触发外部连接或渲染。

## 图片与故障恢复

PNG 先完整写入临时文件并 flush，再以 SHA-256 命名持久化。SQLite 事务同时切换已发布配置和图片指针。并发请求合并为各类最新待处理任务，人工发布优先；旧任务提交前检查序号。设备 GET 只读文件，不取数、不渲染；支持强 ETag、弱条件标签与304。

进程重启将运行中/排队任务标记中断；校验发布图片的哈希、尺寸与通道，损坏时寻找上一有效发布。没有有效图返回503。仍保留草稿和修订号。当前保留历史图片用于恢复，尚无自动磁盘配额清理；长期运行需监控 data 占用。

备份：停止服务，整体复制 data 目录（含 SQLite/WAL/SHM 和 images）以及单独保管的 `.local/admin-password.txt`。未来使用凭据工具后必须另备份对应主密钥。恢复前停服务，恢复完整集合后启动；不要只复制 PNG 或在线随意复制单个 SQLite 文件。只读图片 URL 原文不存数据库，丢失后在管理页轮换并更新设备配置。

生产操作错误以安全类别返回，不回显请求体、凭据或上游响应。浏览器只保存当前编辑状态，未使用 localStorage 存密钥。

## 迁移到 NAS

服务地址与 Kindle 地址分别配置：

- 服务端通过 `HOST`、`PORT` 和 `INKSTACK_ORIGIN` 配置。裸机运行时可让 `HOST` 使用 NAS 的固定局域网 IP；容器内通常使用 `HOST=0.0.0.0`，但端口发布应只绑定 NAS 的局域网接口。`INKSTACK_ORIGIN` 始终填写浏览器实际访问的完整来源，例如 `http://192.168.1.20:3210`。
- Kindle 使用 `extensions/onlinescreensaver/bin/config.sh` 中的 `IMAGE_URI`。`TEST_DOMAIN` 应改为 NAS 的局域网 IP；刷新周期使用同一文件中的 `SCHEDULE`。
- 屏幕分辨率在 InkStack 网页的画布设置中保存。组件字号根据相对于 600×800 基准的屏幕密度自动缩放，迁移主机不需要重新设置字号。

迁移时先停止旧服务和新服务，整体复制 `data` 目录。这样会保留看板、发布 PNG 及显示令牌的服务端哈希；图片 URL 的令牌路径可以继续使用，只需把主机部分从电脑 IP 改为 NAS IP。若没有迁移原 `data`，必须在新服务管理页创建新的图片地址，并更新 Kindle。

管理员密码与数据库分开保存。需要保留原密码时复制 `.local/admin-password.txt` 并限制权限；也可以让 NAS 首次启动生成新密码。为便于重新生成 Kindle 配置，可同时安全迁移 `.local/browser-display-url.txt`，该文件含只读显示令牌，不能提交仓库或放入共享备份。

在电脑上重新生成设备配置的 PowerShell 示例：

```powershell
$env:INKSTACK_DEVICE_ORIGIN = 'http://192.168.1.20:3210'
.\.tools\node-v24.20.0-win-x64\node.exe scripts\stage-kindle.mjs
```

通过 USB 修改设备前，先在 KUAL 选择 **Online Screensaver → Disable auto-download**。生成后将 `.local/device-staging/onlinescreensaver-pw3/bin/config.sh` 复制到 Kindle 的 `extensions/onlinescreensaver/bin/config.sh`，安全弹出设备，再在 KUAL 选择 **Enable auto-download**。不要同时运行两个指向同一 `data` 目录的服务实例。
