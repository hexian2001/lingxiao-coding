/**
 * OfficeRoutes — v1.0.5 剑阁大改：直接 HTTP API 生成办公文件
 *
 * 包装 Generate*Tool 为 HTTP 端点，前端无需通过 Agent 对话即可直接生成 PDF/PPTX/DOCX/XLSX。
 * 每个 endpoint 接收结构化 JSON body，内部实例化对应 Tool 并执行，
 * 返回文件路径和下载链接。
 */

import type { FastifyInstance } from 'fastify';
import type { AuthFn } from './types.js';
import { GeneratePptxTool } from '../tools/implementations/GeneratePptxTool.js';
import { GenerateDocxTool } from '../tools/implementations/GenerateDocxTool.js';
import { GeneratePdfTool } from '../tools/implementations/GeneratePdfTool.js';
import { GenerateXlsxTool } from '../tools/implementations/GenerateXlsxTool.js';
import type { ToolContext } from '../tools/Tool.js';
import { tempDownloadRegistry } from '../core/TempDownloadRegistry.js';
import { coreLogger } from '../core/Log.js';

interface OfficeRoutesDeps {
  requireServerToken: AuthFn;
  getActiveSessionId: () => string | undefined;
}

type OfficeFormat = 'pdf' | 'pptx' | 'docx' | 'xlsx';

interface OfficeGenerateBody {
  format: OfficeFormat;
  /** 生成参数，直接透传给对应 Tool 的 schema */
  params: Record<string, unknown>;
  /** 可选：指定输出路径 */
  outputPath?: string;
  /** 可选：是否创建下载链接（默认 true） */
  createDownloadLink?: boolean;
}

function sendError(reply: { status: (code: number) => { send: (body: unknown) => void } }, status: number, error: unknown): void {
  reply.status(status).send({ error: error instanceof Error ? error.message : String(error) });
}

export function registerOfficeRoutes(fastify: FastifyInstance, deps: OfficeRoutesDeps): void {
  const { requireServerToken, getActiveSessionId } = deps;

  /**
   * POST /api/v1/office/generate
   * 直接生成办公文件，无需 Agent 对话流程。
   */
  fastify.post('/api/v1/office/generate', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const body = request.body as OfficeGenerateBody | undefined;

    if (!body?.format) {
      reply.status(400).send({ error: 'format is required (pdf|pptx|docx|xlsx)' });
      return;
    }

    const sessionId = getActiveSessionId() || 'default';    const toolContext: ToolContext = {
      sessionId,
      workspace: process.cwd(),
    };

    let toolInstance;
    let toolParams: Record<string, unknown>;

    try {
      switch (body.format) {
        case 'pdf':
          toolInstance = new GeneratePdfTool();
          toolParams = { ...body.params };
          if (body.outputPath) toolParams.output_path = body.outputPath;
          break;
        case 'pptx':
          toolInstance = new GeneratePptxTool();
          toolParams = { ...body.params };
          if (body.outputPath) toolParams.path = body.outputPath;
          break;
        case 'docx':
          toolInstance = new GenerateDocxTool();
          toolParams = { ...body.params };
          if (body.outputPath) toolParams.path = body.outputPath;
          break;
        case 'xlsx':
          toolInstance = new GenerateXlsxTool();
          toolParams = { ...body.params };
          if (body.outputPath) toolParams.path = body.outputPath;
          break;
        default:
          reply.status(400).send({ error: `Unsupported format: ${body.format}` });
          return;
      }
    } catch (error) {
      sendError(reply, 500, error);
      return;
    }

    try {
      const result = await toolInstance.execute(toolParams, toolContext);
      if (!result.success) {
        reply.status(400).send({ error: result.error || 'Generation failed' });
        return;
      }

      // 尝试创建下载链接
      let downloadUrl: string | null = null;
      if (body.createDownloadLink !== false && result.data) {
        const data = result.data as Record<string, unknown>;
        const filePath = data.path as string | undefined;
        if (filePath) {
          try {
            const download = tempDownloadRegistry.create({
              path: filePath,
              name: filePath.split('/').pop() || `output.${body.format}`,
              expiresInSeconds: 3600,
            });
            downloadUrl = download.url;
          } catch (err) {
            coreLogger.warn(`[OfficeRoutes] Failed to create download link: ${err}`);
          }
        }
      }

      return {
        data: {
          success: true,
          format: body.format,
          ...result.data as Record<string, unknown>,
          downloadUrl,
        },
      };
    } catch (error) {
      sendError(reply, 500, error);
    }
  });

  /**
   * GET /api/v1/office/templates
   * 返回可用模板列表（前端选择器用）。
   */
  fastify.get('/api/v1/office/templates', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    const templates = [
      { id: 'lingxiao_board', name: '董事会', group: '商务' },
      { id: 'enterprise_report', name: '企业报告', group: '商务' },
      { id: 'product_strategy', name: '产品策略', group: '商务' },
      { id: 'ink_wash', name: '墨韵极简', group: '简约' },
      { id: 'vermilion', name: '朱砂典藏', group: '文化' },
      { id: 'cyan_blade', name: '青锋科技', group: '科技' },
      { id: 'gold_leaf', name: '金箔商务', group: '商务' },
      { id: 'editorial', name: '编辑杂志', group: '编辑' },
      { id: 'dark_luxury', name: '暗色高级', group: '高级' },
      { id: 'papyrus', name: '宣纸纯净', group: '简约' },
    ];
    return { data: templates };
  });

  /**
   * GET /api/v1/office/formats
   * 返回支持的格式和能力描述（前端面板用）。
   */
  fastify.get('/api/v1/office/formats', async (request, reply) => {
    if (!requireServerToken(request, reply)) return;
    return {
      data: [
        {
          format: 'pdf',
          name: 'PDF 文档',
          icon: 'FileText',
          description: 'pdfkit 生成，支持标题/段落/列表/表格/图片/页眉页脚',
          extensions: ['.pdf'],
        },
        {
          format: 'pptx',
          name: 'PPTX 演示',
          icon: 'Presentation',
          description: 'pptxgenjs 原生生成，支持母版/版式/图表/动画/备注',
          extensions: ['.pptx'],
        },
        {
          format: 'docx',
          name: 'DOCX 文档',
          icon: 'FileEdit',
          description: 'docx 库生成，支持标题/段落/列表/表格/分页/模板',
          extensions: ['.docx'],
        },
        {
          format: 'xlsx',
          name: 'XLSX 表格',
          icon: 'Sheet',
          description: 'exceljs 生成，支持多工作表/公式/条件格式/图表',
          extensions: ['.xlsx'],
        },
      ],
    };
  });
}
