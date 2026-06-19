/**
 * 工具结果 / 输入参数 的统一展示组件：按推断出的 Prism 语言做语法高亮。
 *
 * 设计要点（项目约束）：
 * - **memo**：父组件（ToolCallCard / AgentMessageView）流式期间每帧重渲染，
 *   本组件 props（text/language/failed/variant）在终态稳定后即跳过重渲染，
 *   守住流式性能。调用方只在「终态」渲染本组件，流式拼接期仍用裸 `<pre>`。
 * - **主题自取**：内部读 useThemeStore，免去向 ToolCallCard/AgentMessageView
 *   逐层传 isDark prop（不改它们的签名与调用点）。zustand selector 订阅极轻。
 * - **plaintext 短路**：plaintext 语言直接裸文本渲染，跳过 PrismAsync tokenize——
 *   绝大多数 shell 日志 / 普通文本结果走这条，是性能底线。
 * - 限高滚动由外层 .tool-output-scroll / .agent-output-scroll 承担（theme.css），
 *   去掉旧的 200/120 硬截断：小结果全显示，大结果滚动。
 */
import { memo } from 'react';
import { PrismAsync as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useThemeStore } from '../../stores/themeStore';
import { isPlaintext } from './toolOutputFormat';

interface Props {
  /** 已规范化的最终文本（结果或参数）。 */
  text: string;
  /** Prism 语言；'plaintext' 触发短路。 */
  language: string;
  /** 失败结果 → 朱砂红基色。 */
  failed?: boolean;
  /** leader=主聊天(11px) / agent=子Agent面板(10px)。 */
  variant?: 'leader' | 'agent';
}

const PADDING: Record<NonNullable<Props['variant']>, string> = {
  leader: '12px 16px',
  agent: '10px 12px',
};
const FONT_SIZE: Record<NonNullable<Props['variant']>, string> = {
  leader: '11px',
  agent: '10px',
};

function ToolOutputView({ text, language, failed = false, variant = 'leader' }: Props) {
  const isDark = useThemeStore((s) => s.resolved) === 'dark';
  const scrollClass = variant === 'agent' ? 'agent-output-scroll' : 'tool-output-scroll';
  const padding = PADDING[variant];
  const fontSize = FONT_SIZE[variant];
  const baseColor = failed ? 'var(--color-accent-red)' : 'var(--color-text-secondary)';

  // plaintext 短路：不进 PrismAsync，直接等宽换行文本。
  if (isPlaintext(language)) {
    return (
      <div className={`${scrollClass}${failed ? ' text-accent-red' : ''}`}>
        <pre
          style={{
            margin: 0,
            padding,
            fontSize,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: 'transparent',
            color: baseColor,
          }}
        >
          {text}
        </pre>
      </div>
    );
  }

  return (
    <div className={`${scrollClass}${failed ? ' text-accent-red' : ''}`}>
      <SyntaxHighlighter
        language={language}
        style={isDark ? oneDark : oneLight}
        PreTag="div"
        showLineNumbers={text.split('\n').length > 3}
        lineNumberStyle={{ minWidth: '2.5em', paddingRight: '1em', opacity: 0.3, fontSize, userSelect: 'none' }}
        customStyle={{
          margin: 0,
          borderRadius: 0,
          fontSize,
          lineHeight: '1.6',
          padding,
          maxWidth: '100%',
          overflowX: 'auto',
          // 透明：让外层 .xxx-scroll 的 var(--color-bg-code) 透出（CSS 再加 !important 双保险压住 oneDark/oneLight 内联背景）。
          background: 'transparent',
          color: failed ? 'var(--color-accent-red)' : (isDark ? '#c9d1d9' : '#24292e'),
        }}
        codeTagProps={{ style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }}
      >
        {text}
      </SyntaxHighlighter>
    </div>
  );
}

export default memo(ToolOutputView);
