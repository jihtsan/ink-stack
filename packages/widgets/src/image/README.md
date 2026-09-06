# 图片 / 相册组件

已实现元数据、配置校验、纯 SVG 绘制、受控目录扫描、确定性轮换和服务端 PNG 解码。应用层已接入鉴权相册/目录登记、相册上传、图片列表、扫描缓存、选择持久化、预览/发布和调度；未绑定相册时显示“请选择相册”。不支持远程 URL、浏览器读取服务器文件、任意用户路径或 SVG 文件。

## 配置与尺寸

`sourceType` 为 `album`（平台上传存储目录）或 `directory`（管理员登记的目录）；`sourceId`、`sourceRevision` 引用受控资源版本。默认 `unconfigured` 是占位 ID。服务器目录和 NAS 挂载路径不进入看板配置。

`recursive` 控制子目录；`selection` 支持随机 `random`、文件名排序 `sequential`、固定 `fixedImageId`。默认每小时轮换，`rotationSeconds` 范围 60 秒到一年。`noRepeat` 控制随机一轮内不重复；顺序始终遍历，固定模式忽略周期。固定 ID 从扫描结果选择，失效时明确显示“所选图片已移除”。

`fit=contain` 保持比例并留白，`cover` 居中裁剪填满。`padding` 为基础屏幕比例下的留白，另支持灰度、标题、图片名和边框。二维码使用 contain 并保留静区；可扫描性仍需实机验证。关闭组件灰度可保留彩色中间绘制，最终设备 PNG 仍遵循平台统一灰度处理。

| 尺寸 | 布局 |
| --- | --- |
| 2×2 | 单图，上方标题、可选底部图片名 |
| 4×2 | 横图，启用图片名时在右侧排列 |
| 4×3 | 大图，上方标题、底部图片名 |
| 4×4 | 更高图片区，可选底部说明 |

最小区域 160×120 像素。文字转义并按宽度截断；旧图/跳过坏图提示优先占底部，同一区域图片名让位给状态。

## 服务端接入

从 `@ink-stack/widgets/image/server` 导入 `prepareImageAlbum`、`selectImage` 及类型。解码器在 `apps/server/src/services/image-decoder.ts`，复用现有 sharp，无新增依赖。

1. 平台鉴权后从服务器登记表取得 `ManagedImageSource[]`（type/id/revision/root）。不得将请求体直接作为登记记录；来源变更创建新版本。
2. 调用 `prepareImageAlbum({config, sources, now, decode: decodeImagePng, signal})`，返回只含脱敏图片名、PNG 数据和状态的 `PreparedImageAlbum`，没有磁盘路径。平台缓存该快照。
3. 调用 `selectImage({config, album, now, seed: widget.id, saved})`，将 `envelope` 送入已有渲染数据映射，将 `selection` 存在服务器。不同实例使用不同稳定种子；预览/发布共用固定时间与快照。
4. `renderImageWidget` 只读取输入，不访问网络、文件、系统时间或随机数。公共 catalog 不导出扫描器；注册组件不会自动创建接口和调度器。

扫描只接受 PNG/JPEG/WebP 扩展名；解码器校验真实格式、完整解码、EXIF 方向、去元数据与透明度，拒绝 SVG 和动画。输入限制 2000 万像素，输出最多 2048×2048，sharp 转换设置 5 秒超时。

扫描上限：2000 目录项、128 候选图片、8 层子目录、单文件 16 MiB、单输出 PNG 8 MiB、总 PNG 32 MiB。拒绝根目录符号链接/junction，跳过子链接、硬链接和特殊文件；验证真实路径归属与打开文件身份并限制读取长度。遍历不完整或超限时丢弃部分结果。坏图跳过并计数；全坏图、真正空目录和不可访问分别显示。系统错误和路径不返回浏览器。

**操作系统边界：** 登记目录及其父目录由可信管理员控制；上传采用临时文件＋原子改名，不允许用户直接替换目录/链接。Node 路径检查不构成抵御并发恶意目录重命名的 OS 沙箱；不可信共享目录应经隔离导入进程复制到平台拥有的只读快照。NAS I/O 超时由部署控制；signal 在遍历、读取及解码前后检查，不能中断已进入内核的挂载 I/O 或任意自定义解码器。平台需限并发并在隔离进程设置整次扫描超时。

## 稳定轮换与旧图

窗口以 Unix epoch 起算：`floor(now / rotationSeconds)`。随机根据稳定种子、选择策略、内容指纹和轮次进行 SHA-256 排序；每轮遍历全部图片，不调用 Math.random，不依赖目录枚举顺序。相邻两轮边界允许重复。

**平台必须冻结整轮的已解码相册快照**，才能在目录持续增删时保持一轮不重复；重新扫描建议下一轮启用。保存的 selection 可在同一窗口重新扫描后保留仍存在的图片 ID；键绑定资源版本、递归策略、实例种子和选择策略。若文件内容在 ID 不变时被替换，需复用已准备快照才能保证预览像素也不变。

不可访问/超限时可传入 `previous: {album, selection}`，默认最多显示 24 小时旧图并标注，平台可用 `maxStaleMs` 收紧。空目录、全坏图、固定图移除、来源切换不会继续展示旧资源。权限撤销必须立即清理来源缓存，不使用旧图兜底。整个看板绘制失败时保留已发布 PNG 由发布服务负责。

## 部署前仍需验证

- NAS、大相册、资源目录权限、扫描耗时和长期磁盘占用需按部署环境验证；应用已提供基本大小、路径、并发合并和引用保护。
- 上传配额、孤儿相册垃圾回收和不可信共享目录的隔离导入仍属于部署策略；当前删除资源不会递归删除其文件。
- 数据采集已接入现有 registry 生成 PNG；真实 Kindle/固件、二维码可读性仍需实测。

## 验证

在 Node.js 24 下从仓库根目录运行：

```sh
npm run build -w @ink-stack/shared
npm run build -w @ink-stack/widgets
npx vitest run packages/widgets/src apps/server/src/services/image-decoder.test.ts
npm run typecheck
npm run lint
```

fixtures 包含正常、空目录、全坏图、不可访问、固定图缺失、超限、未配置、旧图；PNG 为自行生成红蓝色块，无第三方图片。测试覆盖非法配置、确定性、不重复、缓存隔离、坏图/链接、扫描限制、PNG 解码及 SVG 栅格化后的真实留白/裁剪/灰度像素。

`photoFrame` 可启用 PaperCraft 相纸卡片，`caption` 设置题字（最长 80 字符），配合 `showCaption` 控制底部文字。无题字时显示文件名。新建实例默认开启相纸、题字和填满裁切；旧实例缺少该字段时保留原布局。用户上传图片仍由原有安全解码流程处理，不打包参考照片。
