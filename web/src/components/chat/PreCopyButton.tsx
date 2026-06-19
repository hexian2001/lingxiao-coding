import { useState, useCallback } from 'react';
import { Copy, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface PreCopyButtonProps {
  /** 要复制的完整文本（非截断预览）。 */
  text: string;
  className?: string;
}

/**
 * 通用「复制」按钮：复制任意文本，2s 内显示 Copied 绿色反馈。
 * 复制策略与 MessageBubble 的 CodeBlock 一致（clipboard API + textarea 兜底）。
 * 用于工具入参/输出/结果 <pre> 块，让用户一键取走完整内容。
 */
export default function PreCopyButton({ text, className = '' }: PreCopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* clipboard unavailable */ }
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [text]);

  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono transition-all duration-200 ${
        copied
          ? 'bg-[var(--color-success-bg)] text-accent-green'
          : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'
      } ${className}`}
      onClick={handleCopy}
      title={copied ? t('common.copied', 'Copied') : t('common.copy', 'Copy')}
      aria-label={copied ? t('common.copied', 'Copied') : t('common.copy', 'Copy')}
    >
      {copied ? <CheckCircle2 size={11} /> : <Copy size={11} />}
    </button>
  );
}
