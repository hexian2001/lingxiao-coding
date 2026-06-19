---
name: design-market
description: "凌霄设计素材市场。提供完整主题参考网站查询，用于审美校准、业务页面构图和信息架构参考；不是组件库，不提供可复制代码。"
license: Complete terms in LICENSE.txt
---

# Design Market — 完整主题参考网站

使用 `design_asset` 查询完整主题参考网站。它不是组件库，也不是 CSS/HTML 代码仓库；返回内容只能作为业务化设计参考。

## 工具接口

```ts
design_asset({
  action?: "search" | "themes" | "tags",
  theme?: string,
  tags?: string[],
  search?: string,
  limit?: number
})
```

## 返回内容

工具只返回参考信息：

- `prompt`: 主题参考站的审美、构图、信息架构和业务适配提示
- `usagePolicy`: 使用边界和禁止事项
- `referenceOnly: true`: 明确只读参考
- `previewAvailableInDesignMarket`: 是否可在素材市场页面查看预览
- `id` / `name` / `title` / `description` / `category` / `tags`: 检索和理解主题用的元信息

工具绝不返回：

- `css`
- `html`
- `react`
- `tailwind`
- `previewHtml`
- 可复制 DOM/CSS 或任何可直接粘贴落地的代码片段

## 使用原则

1. **不是组件库**：不要把主题参考站当作按钮、卡片、导航、表格等组件集合。
2. **必须结合业务**：先理解用户产品、内容、转化目标、操作路径和数据层级，再借鉴主题语言重新设计。
3. **禁止复制**：不得复制、改写或拼接参考站里的 DOM、CSS、React、Tailwind、previewHtml 或视觉结构。
4. **禁止堆叠**：一个页面选择一个主参考主题即可，不要把多个主题、装饰、特效和排版语法堆在一起。
5. **禁止换皮**：不要只把业务页面套成参考站配色；必须重构信息架构、节奏、留白、层级和交互优先级。
6. **输出业务方案**：最终交付应是面向当前业务的原创页面，而不是“像某个主题”的拼贴。

## 推荐流程

1. 调用 `design_asset({ action: "themes" })` 查看可用完整主题参考站。
2. 按业务关键词查询，例如 `design_asset({ search: "saas dashboard" })`。
3. 选择一个主主题后，读取其 `prompt` 和 `usagePolicy`。
4. 用主题的审美约束指导原创设计：重写文案、数据、布局、交互和视觉层级。
5. 实现时从当前业务需求出发自行编写代码，不从素材市场复制任何 DOM/CSS。
