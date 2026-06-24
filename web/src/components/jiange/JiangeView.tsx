/**
 * JiangeView — v1.0.5 剑阁全屏工作台
 * 
 * 大改重构后的剑阁面板：
 * - 全屏/分屏布局，大幅提升屏幕占比
 * - 真实浏览器交互（点击触发、评论直接修改 HTML）
 * - 文件画布（文件目录树 + 全功能预览 + 联动）
 * - Office 生成器（直接生成 PDF/PPTX/DOCX/XLSX）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useJiangeStore, type JiangeTab } from '../../stores/jiangeStore';
import { JiangeBrowser } from './JiangeBrowser';
import { FileCanvas } from './FileCanvas';
import { OfficeGenerator } from './OfficeGenerator';
import {
  Globe, FolderTree, FileText, Columns2, Maximize2,
  RefreshCw, ChevronLeft, ChevronRight,
} from 'lucide-react';

type LayoutMode = 'split' | 'single-browser' | 'single-files' | 'single-office';

const TAB_CONFIG: Record<JiangeTab, { icon: React.ReactNode; label: string }> = {
  browser: { icon: <Globe size={14} />, label: '浏览器' },
  files: { icon: <FolderTree size={14} />, label: '文件画布' },
  office: { icon: <FileText size={14} />, label: '办公生成' },
  split: { icon: <Columns2 size={14} />, label: '分屏' },
};

export default function JiangeView() {
  const activeTab = useJiangeStore((s) => s.activeTab);
  const setActiveTab = useJiangeStore((s) => s.setActiveTab);
  const splitLeftTab = useJiangeStore((s) => s.splitLeftTab);
  const splitRightTab = useJiangeStore((s) => s.splitRightTab);
  const setSplitTabs = useJiangeStore((s) => s.setSplitTabs);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('split');
  const [splitRatio, setSplitRatio] = useState(0.5);
  const splitterRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  // Splitter drag
  const handleMouseDown = useCallback(() => {
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !splitterRef.current?.parentElement) return;
      const parent = splitterRef.current.parentElement;
      const rect = parent.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      setSplitRatio(Math.min(0.8, Math.max(0.2, ratio)));
    };
    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const tabs: JiangeTab[] = ['browser', 'files', 'office', 'split'];

  const renderPanel = (tab: JiangeTab) => {
    switch (tab) {
      case 'browser':
        return <JiangeBrowser />;
      case 'files':
        return <FileCanvas />;
      case 'office':
        return <OfficeGenerator />;
      default:
        return <JiangeBrowser />;
    }
  };

  const effectiveLayout: LayoutMode = activeTab === 'split' ? 'split' : `single-${activeTab}` as LayoutMode;

  return (
    <div className="flex h-full flex-col bg-bg-secondary overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-3 h-9 border-b border-border-subtle bg-bg-tertiary flex-shrink-0">
        <span className="text-[13px] font-bold text-accent-brand mr-2 flex items-center gap-1.5">
          <span className="text-base">⚔</span> 剑阁
        </span>
        <div className="h-4 w-px bg-border-subtle mx-1" />
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] font-medium transition-colors ${
              activeTab === tab
                ? 'bg-accent-brand/15 text-accent-brand'
                : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
            }`}
          >
            {TAB_CONFIG[tab].icon}
            {TAB_CONFIG[tab].label}
          </button>
        ))}
        <div className="flex-1" />
        {activeTab === 'split' && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setSplitTabs('browser', 'files')}
              className={`px-2 py-0.5 rounded text-[10px] font-mono ${
                splitLeftTab === 'browser' && splitRightTab === 'files'
                  ? 'bg-accent-brand/20 text-accent-brand' : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              浏览器 | 文件
            </button>
            <button
              onClick={() => setSplitTabs('browser', 'office')}
              className={`px-2 py-0.5 rounded text-[10px] font-mono ${
                splitLeftTab === 'browser' && splitRightTab === 'office'
                  ? 'bg-accent-brand/20 text-accent-brand' : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              浏览器 | 办公
            </button>
            <button
              onClick={() => setSplitTabs('files', 'office')}
              className={`px-2 py-0.5 rounded text-[10px] font-mono ${
                splitLeftTab === 'files' && splitRightTab === 'office'
                  ? 'bg-accent-brand/20 text-accent-brand' : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              文件 | 办公
            </button>
          </div>
        )}
      </div>

      {/* Content area */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {effectiveLayout === 'split' ? (
          <>
            <div
              className="flex flex-col min-w-0 overflow-hidden"
              style={{ width: `${splitRatio * 100}%` }}
            >
              <PanelHeader tab={splitLeftTab} />
              <div className="flex-1 min-h-0 overflow-hidden">
                {renderPanel(splitLeftTab)}
              </div>
            </div>
            <div
              ref={splitterRef}
              onMouseDown={handleMouseDown}
              className="w-1.5 bg-border-subtle hover:bg-accent-brand/40 cursor-col-resize flex-shrink-0 transition-colors relative group"
            >
              <div className="absolute inset-y-0 left-0 right-0 flex items-center justify-center">
                <div className="w-0.5 h-8 bg-border-default group-hover:bg-accent-brand/60 rounded-full" />
              </div>
            </div>
            <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
              <PanelHeader tab={splitRightTab} />
              <div className="flex-1 min-h-0 overflow-hidden">
                {renderPanel(splitRightTab)}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 min-h-0 overflow-hidden">
            {renderPanel(activeTab)}
          </div>
        )}
      </div>
    </div>
  );
}

function PanelHeader({ tab }: { tab: JiangeTab }) {
  const config = TAB_CONFIG[tab];
  return (
    <div className="flex items-center gap-1.5 px-3 h-7 border-b border-border-subtle bg-bg-tertiary/50 flex-shrink-0">
      <span className="text-text-tertiary">{config.icon}</span>
      <span className="text-[11px] font-medium text-text-tertiary">{config.label}</span>
    </div>
  );
}
