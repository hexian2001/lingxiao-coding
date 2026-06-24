/**
 * OfficeGenerator — v1.0.5 剑阁办公文件生成器
 *
 * 直接 HTTP API 生成 PDF/PPTX/DOCX/XLSX
 * 不需要通过 Agent 对话，前端直接调用后端 /api/v1/office/generate
 */

import { useCallback, useEffect, useState } from 'react';
import { officeClient, type OfficeFormatInfo, type OfficeTemplate } from '../../api/OfficeClient';
import {
  FileText, Presentation, FileEdit, Sheet, Loader2, Download,
  CheckCircle2, AlertCircle, Sparkles,
} from 'lucide-react';

type Format = 'pdf' | 'pptx' | 'docx' | 'xlsx';

const FORMAT_ICONS: Record<Format, React.ReactNode> = {
  pdf: <FileText size={20} />,
  pptx: <Presentation size={20} />,
  docx: <FileEdit size={20} />,
  xlsx: <Sheet size={20} />,
};

interface GenResult {
  success: boolean;
  format: string;
  path?: string;
  downloadUrl?: string | null;
}

export function OfficeGenerator() {
  const [formats, setFormats] = useState<OfficeFormatInfo[]>([]);
  const [templates, setTemplates] = useState<OfficeTemplate[]>([]);
  const [selectedFormat, setSelectedFormat] = useState<Format>('pptx');
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [title, setTitle] = useState('示例文档');
  const [subtitle, setSubtitle] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<GenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jsonInput, setJsonInput] = useState<string>('');

  useEffect(() => {
    officeClient.getFormats().then(setFormats).catch(() => {});
    officeClient.getTemplates().then(setTemplates).catch(() => {});
  }, []);

  // Update JSON template when format changes
  useEffect(() => {
    setJsonInput(getDefaultJson(selectedFormat));
    setResult(null);
    setError(null);
  }, [selectedFormat]);

  const generate = useCallback(async () => {
    setIsGenerating(true);
    setError(null);
    setResult(null);
    try {
      let params: Record<string, unknown>;
      try {
        params = JSON.parse(jsonInput);
      } catch {
        setError('JSON 参数解析失败，请检查格式');
        setIsGenerating(false);
        return;
      }

      // Add common fields
      if (title) params.title = title;
      if (subtitle) params.subtitle = subtitle;
      if (selectedTemplate) params.template = selectedTemplate;

      const res = await officeClient.generate(selectedFormat, params);
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsGenerating(false);
    }
  }, [selectedFormat, jsonInput, title, subtitle, selectedTemplate]);

  return (
    <div className="flex h-full flex-col bg-bg-primary overflow-auto">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border-subtle bg-bg-tertiary/50">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles size={16} className="text-accent-brand" />
          <h2 className="text-[14px] font-bold text-text-primary">办公文件生成器</h2>
          <span className="text-[10px] text-text-tertiary bg-bg-hover px-1.5 py-0.5 rounded font-mono">Node.js 原生</span>
        </div>
        <p className="text-[11px] text-text-tertiary">
          直接通过 HTTP API 生成 PDF/PPTX/DOCX/XLSX，无需 Agent 对话
        </p>
      </div>

      <div className="flex-1 p-4 space-y-4">
        {/* Format selection */}
        <div>
          <label className="text-[11px] font-medium text-text-secondary mb-2 block">选择格式</label>
          <div className="grid grid-cols-4 gap-2">
            {(['pdf', 'pptx', 'docx', 'xlsx'] as Format[]).map((fmt) => {
              const info = formats.find(f => f.format === fmt);
              return (
                <button
                  key={fmt}
                  onClick={() => setSelectedFormat(fmt)}
                  className={`flex flex-col items-center gap-1 p-3 rounded-lg border transition-all ${
                    selectedFormat === fmt
                      ? 'border-accent-brand bg-accent-brand/10 text-accent-brand'
                      : 'border-border-subtle hover:border-border-default text-text-tertiary'
                  }`}
                >
                  {FORMAT_ICONS[fmt]}
                  <span className="text-[11px] font-medium">{info?.name || fmt.toUpperCase()}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Template selection */}
        {templates.length > 0 && (selectedFormat === 'pptx' || selectedFormat === 'docx') && (
          <div>
            <label className="text-[11px] font-medium text-text-secondary mb-2 block">模板风格</label>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setSelectedTemplate('')}
                className={`px-2.5 py-1 rounded text-[11px] ${
                  !selectedTemplate ? 'bg-accent-brand/15 text-accent-brand' : 'bg-bg-hover text-text-tertiary hover:text-text-secondary'
                }`}
              >
                默认
              </button>
              {templates.map((tpl) => (
                <button
                  key={tpl.id}
                  onClick={() => setSelectedTemplate(tpl.id)}
                  className={`px-2.5 py-1 rounded text-[11px] ${
                    selectedTemplate === tpl.id ? 'bg-accent-brand/15 text-accent-brand' : 'bg-bg-hover text-text-tertiary hover:text-text-secondary'
                  }`}
                >
                  {tpl.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Title + subtitle */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] font-medium text-text-secondary mb-1 block">标题</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-2.5 py-1.5 bg-bg-secondary border border-border-subtle rounded text-[12px] text-text-primary focus:outline-none focus:border-accent-brand/50"
              placeholder="文档标题"
            />
          </div>
          <div>
            <label className="text-[11px] font-medium text-text-secondary mb-1 block">副标题</label>
            <input
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              className="w-full px-2.5 py-1.5 bg-bg-secondary border border-border-subtle rounded text-[12px] text-text-primary focus:outline-none focus:border-accent-brand/50"
              placeholder="可选"
            />
          </div>
        </div>

        {/* JSON params editor */}
        <div>
          <label className="text-[11px] font-medium text-text-secondary mb-1.5 block">
            内容参数 (JSON)
            <span className="text-text-tertiary ml-2">根据格式填写对应结构</span>
          </label>
          <textarea
            value={jsonInput}
            onChange={(e) => setJsonInput(e.target.value)}
            className="w-full h-48 px-3 py-2 bg-bg-secondary border border-border-subtle rounded text-[11px] font-mono text-text-primary focus:outline-none focus:border-accent-brand/50 resize-y"
            spellCheck={false}
          />
        </div>

        {/* Generate button */}
        <div className="flex items-center gap-3">
          <button
            onClick={generate}
            disabled={isGenerating}
            className="flex items-center gap-2 px-5 py-2 rounded-lg bg-accent-brand text-bg-primary text-[13px] font-medium hover:bg-accent-brand/90 disabled:opacity-50"
          >
            {isGenerating ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            {isGenerating ? '生成中...' : `生成 ${selectedFormat.toUpperCase()}`}
          </button>
          {error && (
            <div className="flex items-center gap-1.5 text-[12px] text-accent-red">
              <AlertCircle size={14} />
              <span className="truncate max-w-md">{error}</span>
            </div>
          )}
        </div>

        {/* Result */}
        {result && (
          <div className={`p-4 rounded-lg border ${
            result.success
              ? 'border-accent-green/30 bg-accent-green/5'
              : 'border-accent-red/30 bg-accent-red/5'
          }`}>
            {result.success ? (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle2 size={16} className="text-accent-green" />
                  <span className="text-[13px] font-medium text-accent-green">生成成功！</span>
                </div>
                {result.path && (
                  <div className="text-[11px] font-mono text-text-tertiary mb-2">
                    路径: {result.path}
                  </div>
                )}
                {result.downloadUrl && (
                  <a
                    href={result.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent-brand/15 text-accent-brand text-[12px] font-medium hover:bg-accent-brand/25"
                  >
                    <Download size={14} />
                    下载文件
                  </a>
                )}
              </>
            ) : (
              <div className="flex items-center gap-2 text-[12px] text-accent-red">
                <AlertCircle size={14} />
                生成失败
              </div>
            )}
          </div>
        )}

        {/* Format description */}
        <div className="text-[11px] text-text-tertiary bg-bg-secondary/50 rounded p-3">
          {formats.find(f => f.format === selectedFormat)?.description || ''}
        </div>
      </div>
    </div>
  );
}

function getDefaultJson(format: Format): string {
  switch (format) {
    case 'pptx':
      return JSON.stringify({
        title: "示例演示文稿",
        author: "剑阁工作台",
        slides: [
          {
            layout: "title",
            title: "欢迎使用剑阁",
            subtitle: "Node.js 原生 PPTX 生成",
          },
          {
            layout: "content",
            title: "功能特性",
            bullets: [
              "原生可编辑 PPTX",
              "支持母版和版式",
              "图表和动画",
              "演讲备注",
            ],
          },
        ],
      }, null, 2);
    case 'docx':
      return JSON.stringify({
        title: "示例文档",
        author: "剑阁工作台",
        blocks: [
          { type: "heading", text: "第一章节", level: 1 },
          { type: "paragraph", text: "这是由 Node.js docx 库原生生成的文档。" },
          { type: "bullets", items: ["要点一", "要点二", "要点三"] },
          { type: "heading", text: "表格示例", level: 2 },
          {
            type: "table",
            headers: ["项目", "值", "说明"],
            rows: [
              ["A", "100", "测试数据"],
              ["B", "200", "测试数据"],
            ],
          },
        ],
      }, null, 2);
    case 'pdf':
      return JSON.stringify({
        output_path: ".lingxiao/sessions/default/scratchpad/example.pdf",
        title: "示例 PDF",
        content: {
          title: "剑阁 PDF 生成",
          sections: [
            {
              heading: "概述",
              paragraphs: ["这是由 pdfkit 原生生成的 PDF 文档。"],
            },
            {
              heading: "数据表",
              table: {
                headers: ["名称", "数值"],
                rows: [["A", "100"], ["B", "200"]],
              },
            },
          ],
        },
      }, null, 2);
    case 'xlsx':
      return JSON.stringify({
        title: "示例工作簿",
        sheets: [
          {
            name: "Sheet1",
            columns: [
              { header: "名称", width: 15 },
              { header: "数值", width: 12 },
            ],
            rows: [
              ["A", 100],
              ["B", 200],
              ["C", 300],
            ],
          },
        ],
      }, null, 2);
    default:
      return '{}';
  }
}
