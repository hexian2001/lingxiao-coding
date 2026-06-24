/**
 * OfficeGeneratorCompact — 剑阁侧边面板内的办公文件生成器
 *
 * 直接 HTTP API 生成 PDF/PPTX/DOCX/XLSX
 */

import { useCallback, useEffect, useState } from 'react';
import { officeClient, type OfficeFormatInfo } from '../../api/OfficeClient';
import {
  FileText, Presentation, FileEdit, Sheet, Loader2, Download,
  CheckCircle2, AlertCircle, Sparkles,
} from 'lucide-react';

type Format = 'pdf' | 'pptx' | 'docx' | 'xlsx';

const FORMAT_ICONS: Record<Format, React.ReactNode> = {
  pdf: <FileText size={16} />,
  pptx: <Presentation size={16} />,
  docx: <FileEdit size={16} />,
  xlsx: <Sheet size={16} />,
};

export default function OfficeGeneratorCompact() {
  const [formats, setFormats] = useState<OfficeFormatInfo[]>([]);
  const [selectedFormat, setSelectedFormat] = useState<Format>('pptx');
  const [title, setTitle] = useState('示例文档');
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<{ success: boolean; downloadUrl?: string | null; path?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jsonInput, setJsonInput] = useState('');

  useEffect(() => {
    officeClient.getFormats().then(setFormats).catch(() => {});
  }, []);

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
      try { params = JSON.parse(jsonInput); } catch { setError('JSON 参数解析失败'); setIsGenerating(false); return; }
      if (title) params.title = title;
      const res = await officeClient.generate(selectedFormat, params);
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsGenerating(false);
    }
  }, [selectedFormat, jsonInput, title]);

  return (
    <div className="flex h-full flex-col bg-bg-primary overflow-auto">
      <div className="px-3 py-2 border-b border-border-subtle bg-bg-tertiary/50">
        <div className="flex items-center gap-1.5">
          <Sparkles size={14} className="text-accent-brand" />
          <span className="text-[12px] font-bold text-text-primary">办公文件生成</span>
          <span className="text-[9px] text-text-tertiary bg-bg-hover px-1 py-0.5 rounded font-mono">Node.js</span>
        </div>
      </div>

      <div className="flex-1 p-3 space-y-3">
        {/* Format buttons */}
        <div className="grid grid-cols-4 gap-1.5">
          {(['pdf', 'pptx', 'docx', 'xlsx'] as Format[]).map((fmt) => (
            <button key={fmt} onClick={() => setSelectedFormat(fmt)} className={`flex flex-col items-center gap-1 p-2 rounded border ${selectedFormat === fmt ? 'border-accent-brand bg-accent-brand/10 text-accent-brand' : 'border-border-subtle text-text-tertiary'}`}>
              {FORMAT_ICONS[fmt]}
              <span className="text-[10px] font-medium">{fmt.toUpperCase()}</span>
            </button>
          ))}
        </div>

        {/* Title */}
        <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full px-2 py-1 bg-bg-secondary border border-border-subtle rounded text-[12px] text-text-primary focus:outline-none focus:border-accent-brand/50" placeholder="标题" />

        {/* JSON params */}
        <textarea value={jsonInput} onChange={(e) => setJsonInput(e.target.value)} className="w-full h-32 px-2 py-1.5 bg-bg-secondary border border-border-subtle rounded text-[10px] font-mono text-text-primary focus:outline-none focus:border-accent-brand/50 resize-y" spellCheck={false} />

        {/* Generate */}
        <button onClick={generate} disabled={isGenerating} className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded bg-accent-brand text-bg-primary text-[12px] font-medium hover:bg-accent-brand/90 disabled:opacity-50">
          {isGenerating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {isGenerating ? '生成中...' : `生成 ${selectedFormat.toUpperCase()}`}
        </button>

        {error && <div className="flex items-center gap-1 text-[11px] text-accent-red"><AlertCircle size={12} />{error}</div>}

        {result && result.success && (
          <div className="p-2.5 rounded border border-accent-green/30 bg-accent-green/5">
            <div className="flex items-center gap-1.5 mb-1.5">
              <CheckCircle2 size={14} className="text-accent-green" />
              <span className="text-[12px] font-medium text-accent-green">生成成功</span>
            </div>
            {result.path && <div className="text-[10px] font-mono text-text-tertiary mb-1.5 truncate">{result.path}</div>}
            {result.downloadUrl && <a href={result.downloadUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 px-2 py-1 rounded bg-accent-brand/15 text-accent-brand text-[11px] font-medium hover:bg-accent-brand/25"><Download size={12} />下载</a>}
          </div>
        )}

        <div className="text-[10px] text-text-tertiary bg-bg-secondary/50 rounded p-2">
          {formats.find(f => f.format === selectedFormat)?.description || ''}
        </div>
      </div>
    </div>
  );
}

function getDefaultJson(format: Format): string {
  switch (format) {
    case 'pptx':
      return JSON.stringify({ title: "演示文稿", slides: [{ layout: "title", title: "剑阁 PPTX", subtitle: "Node.js 原生生成" }, { layout: "content", title: "特性", bullets: ["可编辑 PPTX", "母版版式", "图表动画"] }] }, null, 2);
    case 'docx':
      return JSON.stringify({ title: "文档", blocks: [{ type: "heading", text: "章节", level: 1 }, { type: "paragraph", text: "docx 库原生生成。" }, { type: "bullets", items: ["要点一", "要点二"] }] }, null, 2);
    case 'pdf':
      return JSON.stringify({ output_path: ".lingxiao/sessions/default/scratchpad/output.pdf", title: "PDF", content: { title: "剑阁 PDF", sections: [{ heading: "概述", paragraphs: ["pdfkit 生成。"] }] } }, null, 2);
    case 'xlsx':
      return JSON.stringify({ title: "工作簿", sheets: [{ name: "Sheet1", columns: [{ header: "名称", width: 15 }, { header: "数值", width: 12 }], rows: [["A", 100], ["B", 200]] }] }, null, 2);
    default: return '{}';
  }
}
