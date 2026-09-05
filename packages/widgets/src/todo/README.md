# 待办组件 · todo

状态：首版已实现。

展示由配置后台维护的待办事项和完成状态。Kindle 上的 PNG 不能直接勾选，修改事项需要在后台进行并发布。尺寸及验收见 [组件清单](../../../../docs/component-catalog.md)。

该目录包含 `manifest.json`、`config.schema.json`、`defaults.json`、`render.ts` 和 fixtures；首版不接入外部待办服务。列表按完整行数渲染，剩余条目用“还有 N 项”提示。
