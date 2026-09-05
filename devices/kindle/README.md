# Kindle 接入

状态：已识别 Kindle Paperwhite 3 实机并通过 MRPI 安装 linkss；在线屏保扩展已复制，尚待在 KUAL 中手动取图及启用。

## 已识别设备

| 项目 | 实际值 |
| --- | --- |
| 型号 | Kindle Paperwhite 3（KOReader 设备标识 `KindlePaperWhite3`） |
| 序列号 | 仅记录前缀 `G090`，完整序列号不写入仓库 |
| 固件 | 5.16.2.1.1（409747 002） |
| 屏幕 | 1072×1448 |
| 已有环境 | LanguageBreak 越狱痕迹、KUAL、MRPI、KOReader |
| linkss | 已安装 0.25.N-r18981；MRPI 日志以 `done`、`Success!` 结束 |

InkStack 已将看板改为 1072×1448。首次实机显示后确认原固定像素字号偏小，组件排版现按屏幕密度统一缩放约 1.79 倍并发布修订 7。实际 PNG 是原生尺寸的 8-bit 单通道灰度、无 alpha；服务端返回 200，匹配 ETag 时返回 304。

## 客户端与依赖

使用 [kndl-online-screensaver](https://codeberg.org/cryptomilk/kndl-online-screensaver) 的提交 `3356a0d75d9a9094f91156f5e40173516db5cefb`，许可证为 MIT。项目只复制和配置该上游客户端，没有 fork 或改写其执行逻辑。

PW3 需要 MobileRead linkss 的 `Update_linkss_0.25.N_install_pw2_and_up.bin`。本次下载归档 `kindle-linkss-0.25.N-r18981.tar.xz`，MD5 为 `90bc6957b3ae40ca4595e7c1651decde`；所用安装文件 SHA-256 为 `65a23dd71a2c4f41e4733e3290b38ab1706a265eb14cd170b1ff0ea72148a804`。

本地准备脚本：

```powershell
.\.tools\node-v24.20.0-win-x64\node.exe scripts\stage-kindle.mjs
```

脚本从忽略 Git 的 `.local/browser-display-url.txt` 读取只读图片地址，验证格式后写入忽略 Git 的设备暂存目录。输出只含脱敏路径。所有 Kindle shell 脚本统一为 LF；`bash -n` 已检查 8 个脚本。配置关闭日志和磁盘屏保副本，使用服务端原尺寸 PNG、更新后关闭 Wi-Fi，并以 InkStack 主机私网地址作连通性探测，避免依赖公网探测地址。

## 本次安装结果

安装前已复制并逐文件校验：

- `D:\mrpackages\Update_linkss_0.25.N_install_pw2_and_up.bin`
- `D:\extensions\onlinescreensaver\`

用户已安全弹出设备，并通过 **KUAL → Helper → Install MR Packages** 执行安装。重新连接后的证据：

- `D:\linkss\etc\VERSION` 为 `0.25.N @ r18981 on 2023-Jan-04 @ 23:53`。
- `D:\linkss\screensavers\bg_ss00.png` 已生成。
- `mrpackages` 中的安装包已被 MRPI 消费。
- MRPI 日志明确记录 `linkss:install::done` 与 `Success! :)`。
- 在线屏保扩展 13 个文件与本地 SHA-256 逐文件一致。

接下来打开 KUAL → **Online Screensaver** → **Update now**，确认 InkStack 画面显示；成功后选择 **Enable auto-download**，再进行多轮休眠唤醒测试。

如果需要再次通过 USB 读取日志，先在 KUAL 选择 **Online Screensaver** → **Disable auto-download**，再连接 USB；复制或修改脚本后安全弹出，再重新启用。

## 网络与秘密

当前服务只监听电脑的指定私网接口 `http://192.168.100.116:3210`，未绑定公网地址、未改路由器，也未新增防火墙规则。管理请求仍要求登录、会话 cookie 和精确 Origin。Kindle 的 `IMAGE_URI` 含只读显示令牌；令牌不写入仓库、文档、日志或终端输出。轮换令牌后必须重新运行暂存脚本并更新设备配置。

迁移到 NAS 时，服务端地址通过 `HOST`、`PORT`、`INKSTACK_ORIGIN` 设置；设备端地址位于 `extensions/onlinescreensaver/bin/config.sh` 的 `IMAGE_URI`，连通性地址位于 `TEST_DOMAIN`。保留原 `data` 目录时可以沿用令牌路径，只替换 URL 的主机部分。完整步骤见 [部署说明](../../docs/deployment.md#迁移到-nas)。

## 实机验收记录

服务端请求成功不能单独证明 Kindle 已显示画面或进入低功耗休眠。

| 实机验收 | 应记录的证据 | 当前状态 |
| --- | --- | --- |
| linkss 安装 | MRPI 日志、版本文件、安装包已消费 | 已通过 |
| 首次下载与显示 | 服务端请求时间和用户屏幕确认 | 已通过；字号偏小后已发布修订 7 |
| 修订 7 可读性 | 设备显示与用户确认 | 待下一轮唤醒 |
| 连续三轮唤醒、下载、显示、休眠 | 设备日志、服务端请求时间和屏幕照片 | 待验证 |
| 断网后恢复 | 断网期间保留旧图、恢复后的设备日志 | 待验证 |
| 返回阅读模式 | 退出屏保与正常阅读照片/记录 | 待验证 |
| 至少一昼夜续航 | 起止电量、刷新周期、休眠记录 | 待验证 |
