# 日期组件 · date

状态：首版已实现。

按看板时区显示日期和星期，使用平台传入的固定渲染时间。画面是生成时刻的快照，不承诺实时走时。尺寸及验收见 [组件清单](../../../../docs/component-catalog.md)。

该目录包含 `manifest.json`、`config.schema.json`、`defaults.json`、`render.ts` 和 fixtures，无需网络取数文件。渲染使用调用方传入的 `now` 和看板 `timeZone`。
