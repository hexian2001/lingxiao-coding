/**
 * CtxMenuComp — Context menu for canvas and node right-click actions.
 */

import { memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { CtxMenu } from './canvasTypes';
import { getCanvasItems, getNodeItems, getEdgeItems } from './canvasTypes';

const CtxMenuComp = memo(function CtxMenuComp({ menu, onClose, onAction }: {
  menu: CtxMenu; onClose: () => void; onAction: (a: string) => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const items =
    menu.type === 'canvas' ? getCanvasItems() :
    menu.type === 'edge' ? getEdgeItems() :
    getNodeItems();

  useEffect(() => {
    // ReactFlow may stop bubbling mouse events, so listen in capture phase.
    // This keeps the context menu dismissible by a normal left-click anywhere outside it.
    const h = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) onClose();
    };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', h, true);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('pointerdown', h, true); document.removeEventListener('keydown', k); };
  }, [onClose]);

  return (
    <div ref={ref} className="fixed z-50 min-w-[200px] py-1 bg-bg-secondary border border-border-muted rounded-lg shadow-2xl"
      style={{ left: menu.x, top: menu.y }}>
      <div className="px-3 py-1.5 border-b border-border-muted text-[10px] font-mono text-text-tertiary tracking-wider uppercase">
        {menu.type === 'canvas'
          ? t('canvas.menu.canvasActions')
          : menu.type === 'edge'
          ? t('canvas.menu.edgeActions')
          : t('canvas.menu.nodeActions')}
      </div>
      {items.map((it) =>
        it.label === '—' ? (
          <div key={it.id} className="my-1 border-t border-border-muted" />
        ) : (
          <button key={it.id}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-xs transition-colors ${
              it.danger ? 'text-accent-red hover:bg-accent-red/10' : 'text-text-secondary hover:bg-bg-hover'
            }`}
            onClick={() => { onAction(it.id); onClose(); }}>
            <span className="w-4 flex justify-center text-text-tertiary">{it.icon}</span>
            <span className="flex-1 text-left">{it.label}</span>
            {it.k && <span className="text-[10px] text-text-tertiary font-mono">{it.k}</span>}
          </button>
        )
      )}
    </div>
  );
});

export default CtxMenuComp;
