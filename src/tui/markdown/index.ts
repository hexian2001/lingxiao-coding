/**
 * Markdown 渲染模块 for lingxiao_cli TUI.
 *
 * 主路径(buildMessageLogView → MessageLog)消费:
 * - RenderInline: 行内格式(粗/斜/删/行内代码/链接/裸 URL)
 * - colorizeLine: 代码块语法高亮(lowlight / highlight.js)
 * - renderTableToLines / parsePipeTable: GFM 表格(行级管线拍平成逐行 RenderedLogLine)
 * - latexToUnicode / replaceInlineMath / extractDisplayMath: LaTeX 公式 Unicode 近似
 * - getCachedStringWidth: CJK 感知宽度(带 LRU 缓存)
 */

export { RenderInline } from './InlineMarkdownRenderer.js';
export { colorizeLine } from './CodeColorizer.js';
export { renderTableToLines, parsePipeTable, type ColumnAlign } from './tableRender.js';
export { latexToUnicode } from './latexToUnicode.js';
export { replaceInlineMath, extractDisplayMath } from './mathParse.js';
export { getCachedStringWidth } from './textUtils.js';
