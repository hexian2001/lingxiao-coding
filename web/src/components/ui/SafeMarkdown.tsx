import DOMPurify from 'dompurify';
import { createElement, memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

function isSafeUrl(value: string | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) return true;
  try {
    return SAFE_PROTOCOLS.has(new URL(trimmed, window.location.origin).protocol);
  } catch {
    return false;
  }
}

function sanitizeHref(href: string | undefined): string | undefined {
  return isSafeUrl(href) ? href : undefined;
}

function sanitizeSrc(src: string | undefined): string | undefined {
  return isSafeUrl(src) ? src : undefined;
}

const safeDefaults: Components = {
  a: ({ href, children, ...props }) => {
    const safeHref = sanitizeHref(href);
    if (!safeHref) return <span {...props}>{children}</span>;
    return <a {...props} href={safeHref} rel="noreferrer" target="_blank">{children}</a>;
  },
  img: ({ src, alt, ...props }) => {
    const safeSrc = sanitizeSrc(src);
    if (!safeSrc) return null;
    return <img {...props} src={safeSrc} alt={alt ?? ''} />;
  },
};

function withSafeComponents(components?: Components): Components {
  const customLink = components?.a;
  const customImage = components?.img;
  return {
    ...safeDefaults,
    ...components,
    a: customLink
      ? (props) => sanitizeHref(props.href) ? createElement(customLink, { ...props, href: sanitizeHref(props.href) }) : <span>{props.children}</span>
      : safeDefaults.a,
    img: customImage
      ? (props) => sanitizeSrc(props.src) ? createElement(customImage, { ...props, src: sanitizeSrc(props.src) }) : null
      : safeDefaults.img,
  };
}

interface SafeMarkdownProps {
  children: string;
  components?: Components;
  /**
   * 渲染 profile：
   * - 'default'（默认）：skipHtml=true，纯 markdown 渲染，无 HTML
   * - 'mcp-app'：skipHtml=false，通过 DOMPurify 清洗后允许受控 HTML 渲染
   */
  profile?: 'default' | 'mcp-app';
}

/**
 * memo 化 (2026-05-29)：流式期间父组件每帧 re-render，但只要 children（累计 markdown）
 * 和 components 引用不变就跳过 react-markdown 重解析。配合上游 rAF 批处理（一帧最多
 * 一次 children 变化）+ 调用方 useMemo 固定 components，把每 chunk 全量重解析降到每帧一次。
 */
function SafeMarkdown({ children, components, profile = 'default' }: SafeMarkdownProps) {
  // withSafeComponents 每次都新建对象会让 react-markdown 认为 components 变了；用 useMemo 固定。
  const safeComponents = useMemo(() => withSafeComponents(components), [components]);

  // mcp-app profile: 允许 HTML 但经过 DOMPurify 清洗
  const processedChildren = useMemo(() => {
    if (profile !== 'mcp-app') return children;
    try {
      return DOMPurify.sanitize(children, {
        ALLOWED_TAGS: ['div','span','p','a','img','table','thead','tbody','tr','td','th',
          'ul','ol','li','code','pre','strong','em','br','hr','h1','h2','h3','h4','h5','h6',
          'button','input','label','select','option','form','details','summary'],
        FORBID_ATTR: ['onload','onerror','onclick','onmouseover'],
        ALLOW_DATA_ATTR: false,
      }) as string;
    } catch {
      // sanitize 失败时回退到纯文本
      return children;
    }
  }, [children, profile]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml={profile !== 'mcp-app'}
      components={safeComponents}
    >
      {processedChildren}
    </ReactMarkdown>
  );
}

export default memo(SafeMarkdown);

export type { Components as SafeMarkdownComponents };
