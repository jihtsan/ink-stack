# 墨栈 · InkStack

用小组件，搭建你的墨水屏。

InkStack 是一个面向墨水屏的可组合信息看板项目。通过网页配置小组件和布局，由服务端生成适合设备分辨率的 PNG，再由 Kindle 定时唤醒、下载并显示。

## 当前状态

项目已完成仓库初始化，目前包含目录结构、架构草案和开发路线。前后端应用、图片生成、配置存储及设备接入尚未实现，当前没有可运行的服务或安装包。

## 产品方向

- 在网页中添加、配置和排列小组件。
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

1. 阅读 [架构草案](docs/architecture.md)，了解模块边界。
2. 阅读 [小组件协议草案](docs/widgets.md)，了解组件扩展方式。
3. 按 [开发路线](docs/roadmap.md) 完成首个端到端版本。

框架、依赖和启动命令将在应用脚手架阶段确定，并与可运行代码一起补充。当前仓库不包含第三方 Kindle 客户端代码或二进制。

## Kindle 接入

初期使用 [kndl-online-screensaver](https://codeberg.org/cryptomilk/kndl-online-screensaver) 从 InkStack 提供的图片地址获取 PNG。该客户端有独立的机型、固件、KUAL 和 linkss 要求，详见 [接入说明](devices/kindle/README.md)。

## 项目状态约定

文档中的“计划”“草案”和路线图均表示待实现能力。功能完成后，应同时更新使用说明及对应验证结果。
