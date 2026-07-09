/**
 * OfficeOutlineCard — PPT 生成前的大纲蓝图确认卡片
 *
 * 当 Agent 准备生成 PPT 时，先展示大纲供用户确认。
 * 这通过解析 office 生成类工具的 streaming_input（流式参数生成；兼容 HTTP generate_pptx 回放）
 * 来提取 slides 结构，在大纲模式渲染。
 *
 * 同时也可作为独立组件嵌入 OfficeCanvas 的「生成向导」。
 */

import { useState, useMemo } from 'react';
import {
  ListOrdered, ChevronRight, Plus, Trash2, RefreshCw,
  Check, Sparkles, GripVertical,
} from 'lucide-react';

export interface OutlineSlide {
  index: number;
  title: string;
  bullets: string[];
  notes?: string;
}

interface Props {
  slides: OutlineSlide[];
  themeName?: string;
  onConfirm?: (slides: OutlineSlide[]) => void;
  onCancel?: () => void;
  /** 是否可编辑 */
  editable?: boolean;
}

const THEME_PRESETS = [
  { id: 'cyan_blade', name: '青锋科技', color: '#06b6d4' },
  { id: 'gold_leaf', name: '金箔商务', color: '#f59e0b' },
  { id: 'ink_wash', name: '墨韵极简', color: '#6b7280' },
  { id: 'vermilion', name: '朱砂典藏', color: '#dc2626' },
  { id: 'dark_luxury', name: '暗色高级', color: '#1e293b' },
  { id: 'papyrus', name: '宣纸纯净', color: '#f3f4f6' },
];

export default function OfficeOutlineCard({
  slides: initialSlides,
  themeName: initialTheme,
  onConfirm,
  onCancel,
  editable = true,
}: Props) {
  const [slides, setSlides] = useState<OutlineSlide[]>(initialSlides);
  const [selectedTheme, setSelectedTheme] = useState(initialTheme || 'cyan_blade');
  const [editingSlide, setEditingSlide] = useState<number | null>(null);

  const theme = useMemo(
    () => THEME_PRESETS.find((t) => t.id === selectedTheme) || THEME_PRESETS[0],
    [selectedTheme],
  );

  const updateSlideTitle = (index: number, title: string) => {
    setSlides((prev) => prev.map((s, i) => i === index ? { ...s, title } : s));
  };

  const updateSlideBullets = (index: number, bullets: string[]) => {
    setSlides((prev) => prev.map((s, i) => i === index ? { ...s, bullets } : s));
  };

  const addSlide = () => {
    setSlides((prev) => [...prev, { index: prev.length + 1, title: `新页面 ${prev.length + 1}`, bullets: [] }]);
  };

  const removeSlide = (index: number) => {
    setSlides((prev) => prev.filter((_, i) => i !== index).map((s, i) => ({ ...s, index: i + 1 })));
  };

  const handleConfirm = () => {
    onConfirm?.(slides);
  };

  return (
    <div className="rounded-lg border border-border-muted bg-bg-secondary overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle bg-bg-tertiary/50">
        <ListOrdered size={14} className="text-accent-brand" />
        <span className="text-[12px] font-bold text-text-primary">PPT 大纲蓝图</span>
        <span className="text-[10px] text-text-tertiary">{slides.length} 页</span>
        <div className="ml-auto flex items-center gap-1.5">
          {/* 主题选择器 */}
          <div className="flex items-center gap-1">
            {THEME_PRESETS.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelectedTheme(t.id)}
                className={`h-4 w-4 rounded-full border-2 transition-all ${
                  selectedTheme === t.id ? 'border-text-primary scale-110' : 'border-transparent hover:scale-110'
                }`}
                style={{ backgroundColor: t.color }}
                title={t.name}
              />
            ))}
          </div>
          <span className="text-[10px] text-text-tertiary">{theme.name}</span>
        </div>
      </div>

      {/* 大纲列表 */}
      <div className="max-h-[400px] overflow-auto p-2 space-y-1">
        {slides.map((slide, idx) => (
          <div
            key={idx}
            className={`group rounded-md border transition-all ${
              editingSlide === idx
                ? 'border-accent-brand bg-accent-brand/5'
                : 'border-border-muted bg-bg-primary hover:bg-bg-hover'
            }`}
          >
            <div className="flex items-start gap-1.5 px-2 py-1.5">
              {/* 拖拽手柄 */}
              {editable && (
                <GripVertical size={10} className="text-text-quaternary mt-1 cursor-grab shrink-0" />
              )}

              {/* 页码 */}
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-accent-brand/10 text-[10px] font-mono text-accent-brand mt-0.5">
                {idx + 1}
              </span>

              <div className="flex-1 min-w-0">
                {/* 标题 */}
                {editable && editingSlide === idx ? (
                  <input
                    value={slide.title}
                    onChange={(e) => updateSlideTitle(idx, e.target.value)}
                    className="w-full bg-transparent border-b border-border-muted text-[12px] font-medium text-text-primary outline-none focus:border-accent-brand"
                    autoFocus
                  />
                ) : (
                  <div
                    className={`text-[12px] font-medium text-text-primary truncate ${editable ? 'cursor-pointer' : ''}`}
                    onClick={() => editable && setEditingSlide(idx)}
                  >
                    {slide.title || `第 ${idx + 1} 页`}
                  </div>
                )}

                {/* 要点 */}
                {slide.bullets.length > 0 && (
                  <div className="mt-0.5 space-y-0.5">
                    {slide.bullets.slice(0, 3).map((bullet, bi) => (
                      <div key={bi} className="flex items-center gap-1 text-[10px] text-text-tertiary">
                        <ChevronRight size={8} className="shrink-0 text-text-quaternary" />
                        <span className="truncate">{bullet}</span>
                      </div>
                    ))}
                    {slide.bullets.length > 3 && (
                      <div className="text-[10px] text-text-quaternary">+{slide.bullets.length - 3} 更多</div>
                    )}
                  </div>
                )}

                {/* 编辑模式展开 */}
                {editable && editingSlide === idx && (
                  <textarea
                    value={slide.bullets.join('\n')}
                    onChange={(e) => updateSlideBullets(idx, e.target.value.split('\n').filter(Boolean))}
                    className="mt-1 w-full bg-bg-secondary border border-border-muted rounded p-1.5 text-[10px] text-text-secondary outline-none focus:border-accent-brand resize-y"
                    rows={3}
                    placeholder="每行一个要点"
                  />
                )}
              </div>

              {/* 操作按钮 */}
              {editable && (
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => setEditingSlide(editingSlide === idx ? null : idx)}
                    className="flex h-5 w-5 items-center justify-center rounded text-text-tertiary hover:text-accent-blue hover:bg-bg-hover"
                    title="编辑"
                  >
                    <ChevronRight size={10} />
                  </button>
                  <button
                    onClick={() => removeSlide(idx)}
                    className="flex h-5 w-5 items-center justify-center rounded text-text-tertiary hover:text-accent-red hover:bg-bg-hover"
                    title="删除"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 底部操作区 */}
      {editable && (
        <div className="flex items-center gap-1.5 px-3 py-2 border-t border-border-subtle bg-bg-tertiary/30">
          <button
            onClick={addSlide}
            className="flex items-center gap-1 rounded-md border border-border-muted px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover transition-colors"
          >
            <Plus size={10} />
            添加页
          </button>
          <div className="ml-auto flex items-center gap-1.5">
            {onCancel && (
              <button
                onClick={onCancel}
                className="rounded-md border border-border-muted px-2.5 py-1 text-[10px] text-text-tertiary hover:bg-bg-hover transition-colors"
              >
                取消
              </button>
            )}
            <button
              onClick={handleConfirm}
              className="flex items-center gap-1 rounded-md bg-accent-brand px-2.5 py-1 text-[10px] font-medium text-white hover:bg-accent-brand/90 transition-colors"
            >
              <Check size={10} />
              确认生成
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 从 office 生成工具 input（含 slides[]）提取大纲；兼容 HTTP generate 回放。
 */
export function extractOutlineFromInput(input: unknown): OutlineSlide[] | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const slides = obj.slides;
  if (!Array.isArray(slides)) return null;

  return slides.map((slide, idx) => {
    const s = slide as Record<string, unknown>;
    const title = typeof s.title === 'string' ? s.title : `第 ${idx + 1} 页`;
    const bulletsRaw = s.bullets;
    const bullets = Array.isArray(bulletsRaw)
      ? bulletsRaw.filter((b): b is string => typeof b === 'string')
      : [];
    const notes = typeof s.notes === 'string' ? s.notes : undefined;
    return { index: idx + 1, title, bullets, notes };
  });
}
