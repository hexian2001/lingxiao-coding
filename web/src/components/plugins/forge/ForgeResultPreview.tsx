/**
 * ForgeResultPreview — 生成结果预览（代码查看 + Tool 定义 + 验证结果）
 *
 * 展示:
 * - 生成文件列表 + 代码查看器
 * - 分析阶段发现的 Tool 定义
 * - 验证结果（沙箱 + Inspector）
 * - 注册结果
 * - 操作按钮（重新生成/验证/关闭）
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle,
  XCircle,
  FileCode,
  Copy,
  Check,
  RefreshCw,
  Server,
  ShieldCheck,
  AlertTriangle,
  Wrench,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { getJob, validateJob } from './api';
import type { ForgeJobDetail, GeneratedFile } from './types';

interface ForgeResultPreviewProps {
  jobId: string;
  onRegenerate: () => void;
  onClose: () => void;
}

export default function ForgeResultPreview({ jobId, onRegenerate, onClose }: ForgeResultPreviewProps) {
  const { t } = useTranslation();
  const [job, setJob] = useState<ForgeJobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeFile, setActiveFile] = useState(0);
  const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);
  const [validating, setValidating] = useState(false);

  useEffect(() => {
    setLoading(true);
    getJob(jobId, { includeCode: true })
      .then(setJob)
      .catch(() => { /* ignore */ })
      .finally(() => setLoading(false));
  }, [jobId]);

  function toggleTool(idx: number) {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function handleCopy() {
    const files = (job?.generatedCode as { files?: GeneratedFile[] } | undefined)?.files;
    if (!files || !files[activeFile]) return;
    navigator.clipboard.writeText(files[activeFile].content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function handleValidate() {
    setValidating(true);
    try {
      const result = await validateJob(jobId);
      setJob(result.job);
    } catch { /* ignore */ }
    finally { setValidating(false); }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="w-5 h-5 text-accent-brand animate-spin" />
      </div>
    );
  }

  if (!job) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-text-tertiary">
        <AlertTriangle className="w-8 h-8 mb-2" />
        <p className="text-sm">{t('forge.error.loadFailed') || 'Failed to load job details'}</p>
      </div>
    );
  }

  const generatedCode = job.generatedCode;
  const files: GeneratedFile[] =
    generatedCode && 'files' in generatedCode ? generatedCode.files : [];
  const analysis = job.analysis;
  const validationResult = job.validationResult;
  const registeredServer = job.registeredServer;
  const isCompleted = job.state === 'completed';

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-3 border-b border-border-muted">
        <div className="flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-accent-green" />
          <span className="text-sm font-medium text-text-primary">
            {isCompleted
              ? (t('forge.result.completed') || 'Generation Completed')
              : (t('forge.result.title') || 'Generation Result')}
          </span>
          <span className="text-xs text-text-tertiary ml-2">
            {job.request.serverName}
          </span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
          >
            {t('app.close') || 'Close'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Analysis: Tool definitions */}
        {analysis && analysis.tools.length > 0 && (
          <div className="px-5 py-3 border-b border-border-muted">
            <h4 className="text-[10px] uppercase text-text-tertiary font-medium mb-2 flex items-center gap-1">
              <Wrench className="w-3 h-3" />
              {t('forge.result.tools') || 'Tools'} ({analysis.tools.length})
            </h4>
            <div className="space-y-1.5">
              {analysis.tools.map((tool, idx) => (
                <div key={idx} className="border border-border-muted rounded">
                  <button
                    onClick={() => toggleTool(idx)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-hover/50 transition-colors"
                  >
                    {expandedTools.has(idx) ? (
                      <ChevronDown className="w-3.5 h-3.5 text-text-tertiary" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-text-tertiary" />
                    )}
                    <span className="text-xs font-mono text-accent-brand">{tool.name}</span>
                    <span className="text-xs text-text-tertiary truncate flex-1">{tool.description}</span>
                  </button>
                  {expandedTools.has(idx) && (
                    <div className="px-3 pb-2 border-t border-border-muted">
                      <pre className="text-[10px] text-text-secondary font-mono mt-2 overflow-x-auto">
                        {JSON.stringify(tool.inputSchema, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Validation result */}
        {validationResult && (
          <div className="px-5 py-3 border-b border-border-muted">
            <h4 className="text-[10px] uppercase text-text-tertiary font-medium mb-2 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" />
              {t('forge.result.validation') || 'Validation'}
            </h4>
            <div className="grid grid-cols-3 gap-2 mb-2">
              <div className={`flex items-center gap-1.5 text-xs ${validationResult.sandboxCompiled ? 'text-accent-green' : 'text-accent-red'}`}>
                {validationResult.sandboxCompiled ? <CheckCircle className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                {t('forge.result.compiled') || 'Compiled'}
              </div>
              <div className={`flex items-center gap-1.5 text-xs ${validationResult.sandboxStarted ? 'text-accent-green' : 'text-accent-red'}`}>
                {validationResult.sandboxStarted ? <CheckCircle className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                {t('forge.result.started') || 'Started'}
              </div>
              <div className={`flex items-center gap-1.5 text-xs ${validationResult.inspectorConnected ? 'text-accent-green' : 'text-accent-red'}`}>
                {validationResult.inspectorConnected ? <CheckCircle className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                {t('forge.result.inspector') || 'Inspector'}
              </div>
            </div>
            {/* Tool test results */}
            {validationResult.toolsDiscovered.length > 0 && (
              <div className="space-y-0.5 mb-2">
                {validationResult.toolsDiscovered.map((tool, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    {tool.callSuccess ? (
                      <CheckCircle className="w-3 h-3 text-accent-green" />
                    ) : (
                      <XCircle className="w-3 h-3 text-accent-red" />
                    )}
                    <span className="font-mono text-text-secondary">{tool.name}</span>
                    {tool.callError && (
                      <span className="text-accent-red/70 text-[10px] truncate">{tool.callError}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {/* Errors & warnings */}
            {validationResult.errors.length > 0 && (
              <div className="space-y-0.5">
                {validationResult.errors.map((err, i) => (
                  <div key={`err-${i}`} className="text-[10px] text-accent-red flex items-start gap-1">
                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                    <span>{err}</span>
                  </div>
                ))}
              </div>
            )}
            {validationResult.warnings.length > 0 && (
              <div className="space-y-0.5">
                {validationResult.warnings.map((warn, i) => (
                  <div key={`warn-${i}`} className="text-[10px] text-accent-yellow flex items-start gap-1">
                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                    <span>{warn}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Registration result */}
        {registeredServer && (
          <div className="px-5 py-3 border-b border-border-muted">
            <h4 className="text-[10px] uppercase text-text-tertiary font-medium mb-2 flex items-center gap-1">
              <Server className="w-3 h-3" />
              {t('forge.result.registration') || 'Registration'}
            </h4>
            <div className="flex items-center gap-2 text-xs">
              <CheckCircle className="w-3.5 h-3.5 text-accent-green" />
              <span className="text-text-secondary">
                {t('forge.result.registeredAs') || 'Registered as'}: <span className="font-mono">{registeredServer.serverId}</span>
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-tertiary">
                {registeredServer.transport}
              </span>
            </div>
          </div>
        )}

        {/* Generated code files */}
        {files.length > 0 && (
          <div className="flex flex-col" style={{ minHeight: 200 }}>
            <div className="px-5 py-2 border-b border-border-muted flex items-center gap-2">
              <FileCode className="w-3.5 h-3.5 text-text-tertiary" />
              <h4 className="text-[10px] uppercase text-text-tertiary font-medium">
                {t('forge.result.code') || 'Generated Code'} ({files.length} {t('forge.result.files') || 'files'})
              </h4>
              <div className="flex-1" />
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
              >
                {copied ? <Check className="w-3 h-3 text-accent-green" /> : <Copy className="w-3 h-3" />}
                {copied ? (t('forge.result.copied') || 'Copied') : (t('forge.result.copy') || 'Copy')}
              </button>
            </div>
            {/* File tabs */}
            <div className="flex border-b border-border-muted overflow-x-auto">
              {files.map((file, idx) => (
                <button
                  key={idx}
                  onClick={() => setActiveFile(idx)}
                  className={`px-3 py-1.5 text-xs whitespace-nowrap border-b-2 transition-colors ${
                    activeFile === idx
                      ? 'border-accent-brand text-accent-brand'
                      : 'border-transparent text-text-tertiary hover:text-text-secondary'
                  }`}
                >
                  {file.path.split('/').pop()}
                </button>
              ))}
            </div>
            {/* Code view */}
            <div className="flex-1 overflow-auto px-3 py-2 bg-bg-secondary/50">
              <pre className="text-[11px] font-mono text-text-secondary whitespace-pre">
                {files[activeFile]?.content || ''}
              </pre>
            </div>
          </div>
        )}

        {/* No code available */}
        {!files.length && !loading && (
          <div className="px-5 py-6 text-center text-text-tertiary">
            <FileCode className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-xs">{t('forge.result.noCode') || 'No code generated'}</p>
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-between px-5 py-3 border-t border-border-muted">
        <button
          onClick={onRegenerate}
          className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {t('forge.result.regenerate') || 'Regenerate'}
        </button>
        <div className="flex items-center gap-2">
          {!validationResult && (
            <button
              onClick={handleValidate}
              disabled={validating}
              className="flex items-center gap-1 px-3 py-1.5 text-xs border border-border-default rounded text-text-secondary hover:bg-bg-hover disabled:opacity-50 transition-colors"
            >
              {validating ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
              {t('forge.result.validate') || 'Validate'}
            </button>
          )}
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs bg-accent-brand text-white rounded hover:opacity-90 transition-opacity"
          >
            {t('forge.result.done') || 'Done'}
          </button>
        </div>
      </div>
    </div>
  );
}
