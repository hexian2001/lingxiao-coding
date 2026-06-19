import { useWikiStore } from '../../stores/wikiStore';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/sessionStore';
import { useViewStore } from '../../stores/viewStore';
import { useMemo, useEffect, useRef, useCallback, useState } from 'react';
import DOMPurify from 'dompurify';
import SafeMarkdown, { type SafeMarkdownComponents } from '../ui/SafeMarkdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useThemeStore } from '../../stores/themeStore';
import { CheckCircle2, Copy } from 'lucide-react';

/** Language alias map for syntax highlighter */
const langMap: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  json5: 'json',
};

/** 语言图标映射 */
const wikiLangIcons: Record<string, string> = {
  javascript: 'JS', typescript: 'TS', python: 'PY', bash: '$_', sh: '$_',
  rust: 'RS', go: 'GO', java: 'JV', cpp: 'C+', c: 'C', html: '<>', css: '#',
  json: '{}', yaml: 'YM', markdown: 'MD', sql: 'DB', dockerfile: 'DK',
  jsx: 'JX', tsx: 'TX', ruby: 'RB', php: 'PH', swift: 'SW', kotlin: 'KT',
};

/** 代码块组件 — 凌霄主题集成 + 复制反馈 */
function WikiCodeBlock({ code, lang, isDark }: { code: string; lang: string; isDark: boolean }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [code]);

  const icon = wikiLangIcons[lang.toLowerCase()] || lang.slice(0, 2).toUpperCase();

  return (
    <div className="my-4 rounded-lg overflow-hidden border border-border-default group/code"
         style={{ boxShadow: isDark ? '0 0 12px rgba(0,255,200,0.04)' : '0 1px 8px rgba(0,0,0,0.06)' }}>
      {/* 头部栏 */}
      <div className="flex items-center justify-between px-3 py-1.5"
           style={{ background: isDark ? 'rgba(0,255,200,0.04)' : 'rgba(0,149,106,0.05)', borderBottom: '1px solid var(--color-border-muted)' }}>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[9px] font-bold"
                style={{ background: isDark ? 'rgba(0,255,200,0.12)' : 'rgba(0,149,106,0.12)', color: 'var(--color-accent-brand)' }}>
            {icon}
          </span>
          <span className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider">{lang}</span>
        </div>
        <button
          className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono transition-all duration-200"
          style={{
            background: copied
              ? (isDark ? 'rgba(0,255,153,0.12)' : 'rgba(0,149,106,0.12)')
              : 'transparent',
            color: copied ? 'var(--color-accent-green)' : 'var(--color-text-tertiary)',
          }}
          onClick={handleCopy}
          onMouseEnter={(e) => { if (!copied) e.currentTarget.style.background = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'; }}
          onMouseLeave={(e) => { if (!copied) e.currentTarget.style.background = 'transparent'; }}
        >
          {copied ? (
            <>
              <CheckCircle2 size={11} />
              <span>{t('code.copied')}</span>
            </>
          ) : (
            <>
              <Copy size={11} />
              <span>{t('code.copy')}</span>
            </>
          )}
        </button>
      </div>
      {/* 代码区 */}
      <SyntaxHighlighter
        style={isDark ? oneDark : oneLight}
        language={lang}
        PreTag="div"
        showLineNumbers={code.split('\n').length > 3}
        lineNumberStyle={{ minWidth: '2.5em', paddingRight: '1em', opacity: 0.3, fontSize: '11px', userSelect: 'none' }}
        customStyle={{
          margin: 0,
          borderRadius: 0,
          fontSize: '12px',
          lineHeight: '1.6',
          padding: '12px 16px',
          background: 'var(--color-bg-code)',
          color: isDark ? '#c9d1d9' : '#24292e',
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

/** Mermaid diagram renderer — renders on mount after DOM insertion */
function MermaidDiagram({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(false);

    import('mermaid').then((mermaid) => {
      if (cancelled || !containerRef.current) return;
      const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`;
      mermaid.default.initialize({
        startOnLoad: false,
        theme: 'dark',
        themeVariables: {
          primaryColor: '#1a1a25',
          primaryTextColor: '#e0e0f0',
          primaryBorderColor: '#2a2a3a',
          lineColor: '#5a5a75',
          secondaryColor: '#12121a',
          tertiaryColor: '#0a0a0f',
          fontFamily: '"JetBrains Mono", "Noto Sans SC", monospace',
          fontSize: '12px',
        },
        flowchart: { htmlLabels: true, curve: 'basis' },
        sequence: { actorMargin: 50, messageMargin: 35 },
      });

      mermaid.default.render(id, code).then(({ svg }) => {
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
        }
      }).catch(() => {
        if (!cancelled) setError(true);
      });
    }).catch(() => {
      if (!cancelled) setError(true);
    });

    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return (
      <div className="my-3 rounded-lg border border-accent-yellow/30 bg-accent-yellow/5 px-4 py-3">
        <p className="text-xs text-accent-yellow mb-2 font-medium">Mermaid diagram (rendering failed)</p>
        <pre className="text-[11px] text-text-tertiary whitespace-pre-wrap font-mono">{code}</pre>
      </div>
    );
  }

  return (
    <div className="my-3 rounded-lg border border-border-default bg-bg-secondary overflow-x-auto">
      <div className="flex items-center gap-1.5 px-3 py-1 border-b border-border-muted">
        <span className="text-[10px] font-mono text-accent-blue uppercase tracking-wide">Mermaid</span>
      </div>
      <div ref={containerRef} className="px-4 py-3 flex justify-center [&_svg]:max-w-full" />
    </div>
  );
}

/** Cite reference block — styled card showing source files */
function CiteBlock({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="my-3 rounded-lg border border-accent-blue/20 bg-accent-blue/5 px-4 py-3">
      <div className="flex items-center gap-1.5 mb-2">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-blue">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
        <span className="text-[11px] font-medium text-accent-blue">{t('wiki.referencedFiles')}</span>
      </div>
      <div className="text-xs text-text-secondary">{children}</div>
    </div>
  );
}

export default function WikiDocument() {
  const { t } = useTranslation();
  const documentContent = useWikiStore((s) => s.documentContent);
  const selectedDocument = useWikiStore((s) => s.selectedDocument);
  const isLoading = useWikiStore((s) => s.isLoading);
  const mode = useThemeStore((s) => s.mode);
  const isDark = mode === 'dark';
  const setMainView = useViewStore((s) => s.setMainView);
  const sessions = useSessionStore((s) => s.sessions);
  const sessionId = useSessionStore((s) => s.sessionId);
  const workspace = sessions.find((s) => s.id === sessionId)?.workspace || '';

  /**
   * Detect `file:line` style hrefs — e.g. `src/foo.ts:42`, `package.json:18`
   * Returns { filePath, line } when matched, null otherwise.
   */
  const parseFileLink = useCallback((href: string | undefined): { filePath: string; line: number } | null => {
    if (!href || href.startsWith('http') || href.startsWith('#') || href.startsWith('/')) return null;
    const m = href.match(/^(.+):(\d+)$/);
    if (!m) return null;
    const [, rawPath, lineStr] = m;
    // Reject if the part before `:` looks like a protocol (e.g. "mailto")
    if (!/[./\\]/.test(rawPath) && rawPath.length < 3) return null;
    const line = parseInt(lineStr, 10);
    if (isNaN(line) || line < 1) return null;
    return { filePath: rawPath, line };
  }, []);

  /** Extract mermaid blocks before ReactMarkdown sees them, to avoid double-parsing */
  const processedContent = useMemo(() => {
    if (!documentContent) return '';
    // Replace <cite>...</cite> blocks with a custom marker that ReactMarkdown won't mangle
    return documentContent.replace(/<cite>([\s\S]*?)<\/cite>/g, (_match, inner) => {
      const encoded = btoa(unescape(encodeURIComponent(inner)));
      return `\n\n@@CITE:${encoded}@@\n\n`;
    });
  }, [documentContent]);

  /** Map cite markers back to rendered components */
  const renderCiteBlocks = useCallback((html: string) => {
    return html.replace(/<p>@@CITE:([A-Za-z0-9+/=]+)@@<\/p>/g, (_match, encoded) => {
      try {
        const inner = decodeURIComponent(escape(atob(encoded)));
        return `<div class="wiki-cite-block">${inner}</div>`;
      } catch {
        return '';
      }
    });
  }, []);

  if (!selectedDocument) {
    return (
      <div className="flex items-center justify-center h-full text-text-secondary text-sm">
        {t('wiki.selectDocument', 'Select a document from the sidebar')}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-text-secondary text-sm">
        {t('wiki.loading', 'Loading...')}
      </div>
    );
  }

  if (!documentContent) {
    return (
      <div className="flex items-center justify-center h-full text-text-secondary text-sm">
        {t('wiki.notFound', 'Document not found')}
      </div>
    );
  }

  const components: SafeMarkdownComponents = {
    h1: ({ children }) => (
              <h1 className="text-2xl font-bold text-text-primary mt-8 mb-4 pb-3 border-b-2 border-accent-brand/30">
                {children}
              </h1>
            ),
    h2: ({ children }) => (
              <h2 className="text-xl font-bold text-text-primary mt-8 mb-3 pb-2 border-b border-border-default">
                {children}
              </h2>
            ),
    h3: ({ children }) => (
              <h3 className="text-base font-semibold text-text-primary mt-6 mb-2">{children}</h3>
            ),
    h4: ({ children }) => (
              <h4 className="text-sm font-semibold text-text-primary mt-4 mb-1.5">{children}</h4>
            ),
    p: ({ children }) => {
              // Check for cite markers
              const text = typeof children === 'string' ? children : '';
              const citeMatch = text.match(/^@@CITE:([A-Za-z0-9+/=]+)@@$/);
              if (citeMatch) {
                try {
                  const inner = decodeURIComponent(escape(atob(citeMatch[1])));
                  return <CiteBlock><span dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(inner) }} /></CiteBlock>;
                } catch {
                  return null;
                }
              }
              return <p className="text-sm text-text-secondary mb-3 leading-7">{children}</p>;
            },
    ul: ({ children }) => <ul className="list-disc pl-6 mb-3 space-y-1">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-6 mb-3 space-y-1">{children}</ol>,
    li: ({ children }) => <li className="text-sm text-text-secondary leading-6">{children}</li>,
    blockquote: ({ children }) => (
              <blockquote className="border-l-3 border-accent-blue/40 pl-4 my-4 bg-accent-blue/5 py-2 rounded-r-lg">
                {children}
              </blockquote>
            ),
    strong: ({ children }) => <strong className="text-text-primary font-semibold">{children}</strong>,
    em: ({ children }) => <em className="text-accent-blue">{children}</em>,
    a: ({ href, children }) => {
              const fileLink = parseFileLink(href);
              if (fileLink) {
                // Resolve relative path against workspace
                const absPath = fileLink.filePath.startsWith('/')
                  ? fileLink.filePath
                  : workspace ? `${workspace}/${fileLink.filePath}` : fileLink.filePath;
                return (
                  <button
                    className="inline-flex items-center gap-1 text-accent-blue hover:text-accent-brand underline underline-offset-2 transition-colors font-mono text-[12px]"
                    title={t('editor.openFileLink', 'Open in editor')}
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent('lingxiao:open-file', {
                        detail: { path: absPath, line: fileLink.line },
                      }));
                      setMainView('editor');
                    }}
                  >
                    {children}
                  </button>
                );
              }
              return (
                <a href={href} className="text-accent-blue hover:text-accent-brand underline underline-offset-2 transition-colors" target="_blank" rel="noreferrer">
                  {children}
                </a>
              );
            },
    hr: () => <hr className="border-border-muted my-6" />,
    table: ({ children }) => (
              <div className="overflow-x-auto my-4 rounded-lg border border-border-default">
                <table className="w-full text-sm border-collapse">{children}</table>
              </div>
            ),
    thead: ({ children }) => <thead className="bg-bg-tertiary">{children}</thead>,
    th: ({ children }) => (
              <th className="px-4 py-2.5 text-left text-accent-blue font-mono text-xs font-medium border-b border-border-default">
                {children}
              </th>
            ),
    td: ({ children }) => (
              <td className="px-4 py-2 text-text-secondary border-b border-border-muted">{children}</td>
            ),
    code({ className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || '');
              const code = String(children).replace(/\n$/, '');

              // Mermaid diagram
              if (match && match[1] === 'mermaid') {
                return <MermaidDiagram code={code} />;
              }

              const lang = match ? (langMap[match[1]] || match[1]) : null;

              // Fenced code block with syntax highlighting
              if (lang) {
                return (
                  <WikiCodeBlock code={code} lang={lang} isDark={isDark} />
                );
              }

              // Inline code
              return (
                <code className="px-1.5 py-0.5 bg-bg-tertiary text-accent-green text-[12px] font-mono rounded" {...props}>
                  {children}
                </code>
              );
            },
    img: ({ src, alt }) => (
      <div className="my-4">
        <img src={src} alt={alt} className="max-w-full rounded-lg border border-border-default" />
      </div>
    ),
  };

  return (
    <div className="flex-1 overflow-y-auto px-8 py-6">
      <div className="wiki-document max-w-4xl mx-auto">
        <SafeMarkdown components={components}>{processedContent}</SafeMarkdown>
      </div>
    </div>
  );
}
