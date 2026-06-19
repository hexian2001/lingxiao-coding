/**
 * HTML Presentation Generator
 *
 * LLM-native HTML mode only: the model supplies the complete HTML/CSS/JS.
 * The tool only writes the file and returns a downloadable/previewable artifact.
 */

import { z } from 'zod';
import { basename, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { resolveTaskWritePath, lockedAtomicWriteBuffer } from './utils.js';
import { tempDownloadRegistry } from '../../core/TempDownloadRegistry.js';
import { ensureExtension } from './OfficeXmlBuilder.js';

const GenerateHtmlPresentationSchema = z.object({
  output_path: z.string().describe('输出 HTML 文件路径。相对路径基于 workspace，绝对路径原样使用。'),
  html: z.string().min(1).describe('完整 HTML 文档源码。必须由 LLM 自行设计完整 <!DOCTYPE html>、CSS、JS、布局、动画和交互；工具只负责写文件和预览，不套模板、不重排版、不修改审美。HTML 应尽量自包含：资源使用 data URI 或 HTTP(S)；字体优先系统字体。关系型/结构型内容必须视觉化：知识图谱、DAG、架构、流程、状态机、时间线、因果链、对比矩阵、指标数据转译为节点、边、层级、卡片、SVG 图、时间线或矩阵。'),
  create_download_link: z.boolean().default(true),
});

export class GenerateHtmlPresentationTool extends Tool {
  name = 'generate_html_presentation';
  description = `生成 HTML 交互式演示或文档。用于演示稿、视觉表达、长文档、报告、方案、材料等 Web 原生产物；只接受完整 HTML，不提供模板 schema。

使用方式：
- 先由 LLM 自主设计完整 HTML/CSS/JS。
- 如果 HTML 很长，先用本工具生成可运行骨架（结构、主题 token、关键 section、导航/预览脚本），再用 structured_patch 分段补充 CSS、页面、图表和交互。
- 调用本工具传入 html 字段。
- 工具只负责写文件、生成 download_artifact 卡片、支持 Artifact 面板 sandbox iframe 预览。

设计原则：
- 自主完成版式、视觉系统和交互逻辑。
- 传入完整 HTML 源码，而非 slides JSON。
- 内容组织在 HTML/CSS/JS 结构中，而非固定字段。
- HTML 本身就是最强表达层，布局、动效、响应式、图表、控件由 LLM 自行判断；本工具的意义是明确选择 HTML 作为审美表达载体并产出可下载/可预览 artifact。
- 先做信息设计，再写 HTML：判断每页核心信息类型，并选择对应视觉语法。架构画分层图，DAG 画节点-边图，知识图谱画 Fact 节点和关系边，状态机画状态迁移，时间演进画 timeline，对比关系画 matrix，指标数据画 cards/charts/progress。
- 关系型/结构型知识转译为可视化节点、边、标签、层级或矩阵。凡是出现 Fact、supports、refines、contradicts、depends_on、blocked_by、causes、flows_to、DAG、workflow、state transition、architecture 等语义，都用图形语法表达。代码块只用于真实代码、命令或日志。
- 视觉图优先使用原生 HTML/CSS/SVG。SVG 负责边、箭头、关系标签；HTML card 负责节点内容、状态 badge、证据摘要；不依赖 Mermaid 或外部库。
- 自检后再调用工具：非代码内容是否已图形化？关系/流程/知识图谱是否有可视化？所有节点和边是否在 16:9 画布内完整显示？资源是否适合 Web UI / HTTP 预览？
- 生成结果应适合通过凌霄 Web UI / HTTP 预览；本地图片请转 data URI 或放到可 HTTP 访问的路径。
- 字体优先系统字体栈；远程字体只在用户明确要求且网络可用时使用。`;

  parameters = GenerateHtmlPresentationSchema;

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = GenerateHtmlPresentationSchema.parse(input);
    const { output_path, html, create_download_link } = parsed;

    const resolvedPath = resolveTaskWritePath(context.workspace, output_path, context.sessionId, context.taskWriteScope);
    const finalPath = ensureExtension(resolvedPath, '.html');

    const dir = dirname(finalPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    await lockedAtomicWriteBuffer(finalPath, Buffer.from(html, 'utf-8'), { createDirs: true });

    const artifact = create_download_link
      ? tempDownloadRegistry.create({
        path: finalPath,
        name: basename(finalPath),
        mimeType: 'text/html; charset=utf-8',
        expiresInSeconds: undefined,
        sessionId: context.sessionId,
      })
      : undefined;

    return {
      success: true,
      data: artifact ? {
        ...artifact,
        preview_url: artifact.url,
        file_path: finalPath,
        mode: 'html',
      } : {
        message: `HTML 演示已生成: ${finalPath}`,
        path: finalPath,
        file_path: finalPath,
        mode: 'html',
      },
    };
  }
}

export default GenerateHtmlPresentationTool;
