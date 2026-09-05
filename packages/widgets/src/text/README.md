# 文字组件 · text

状态：首版已实现。

显示用户配置的标题与正文，用于留言、提醒和短句。支持尺寸及验收见 [组件清单](../../../../docs/component-catalog.md)。

该目录包含 `manifest.json`、`config.schema.json`、`defaults.json`、`render.ts` 和 fixtures。数据来自本地配置，无需网络取数文件。渲染会按字符换行并截断过长文本，不读取系统时间、网络或凭据。
