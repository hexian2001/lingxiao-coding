/**
 * InkBackground.tsx — 凌霄水墨背景图层
 *
 * 当前采用项目静态资源背景图：亮色 /backgrounds/lingxiao-ink-light.png，暗色 /backgrounds/lingxiao-ink-background.png。
 * 仅负责渲染背景容器；视觉呈现由 ink-decoration.css 控制。
 */

import { memo } from 'react';

export const InkBackground = memo(function InkBackground() {
  return <div className="ink-background" aria-hidden="true" />;
});

export default InkBackground;
