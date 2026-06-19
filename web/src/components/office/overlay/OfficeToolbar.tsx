/**
 * OfficeToolbar — 顶部工具栏
 */
import { useTranslation } from 'react-i18next';
import { ZoomIn, ZoomOut, Maximize2, Navigation, Building2, Crosshair, Eye, Monitor } from 'lucide-react';
import type { OfficeEngine } from '../engine/OfficeEngine';
import { OFFICE_LAYOUT } from '../assets/officeLayout';
import { TILE_SIZE } from '../engine/TileMap';

interface Props { engine: React.RefObject<OfficeEngine | null>; }

export default function OfficeToolbar({ engine }: Props) {
  const { t } = useTranslation();
  const handleZoomIn = () => { const e = engine.current; if (e) e.camera.setZoom(e.camera.zoom * 1.25); };
  const handleZoomOut = () => { const e = engine.current; if (e) e.camera.setZoom(e.camera.zoom * 0.8); };
  const handleFitView = () => { const e = engine.current; if (e) e.camera.fitMap(); };
  const handleResetView = () => { const e = engine.current; if (e) { e.camera.fitMap(); e.camera.setZoom(1.25); } };
  const handleZoneJump = (zoneId: string) => { const e = engine.current; if (!e) return; const a = OFFICE_LAYOUT.areas.find(ar => ar.id === zoneId); if (!a) return; e.camera.centerOn((a.bounds.x + a.bounds.w / 2) * TILE_SIZE, (a.bounds.y + a.bounds.h / 2) * TILE_SIZE); e.camera.setZoom(Math.max(e.camera.minZoom, 2)); };
  const handleFocusActive = () => { const e = engine.current; if (!e) return; for (const [, s] of e.agents) { if (s.animState === 'working' || s.animState === 'thinking') { e.camera.centerOn(s.worldX, s.worldY); e.camera.setZoom(2); break; } } };

  return (
    <div className="absolute top-2 left-2 z-10 flex flex-col gap-1">
      <div className="flex items-center gap-1 bg-bg-primary/80 backdrop-blur-sm rounded-lg border border-border-default px-2 py-1">
        <span className="text-[10px] font-mono text-accent-purple/80 uppercase tracking-wider mr-1">{t('office.title','Team Tower')}</span>
        <div className="w-px h-4 bg-border-default mx-1"/><button onClick={handleZoomIn} className="p-1 rounded hover:bg-bg-secondary text-text-secondary hover:text-text-primary" title={t('office.zoomIn','Zoom In')}><ZoomIn size={14}/></button>
        <button onClick={handleZoomOut} className="p-1 rounded hover:bg-bg-secondary text-text-secondary hover:text-text-primary" title={t('office.zoomOut','Zoom Out')}><ZoomOut size={14}/></button>
        <button onClick={handleFitView} className="p-1 rounded hover:bg-bg-secondary text-text-secondary hover:text-text-primary" title={t('office.fitView','Fit Tower')}><Maximize2 size={14}/></button>
        <button onClick={handleResetView} className="p-1 rounded hover:bg-bg-secondary text-text-secondary hover:text-text-primary" title={t('office.resetView','Reset View')}><Eye size={14}/></button>
        <button onClick={handleFocusActive} className="p-1 rounded hover:bg-bg-secondary text-accent-brand hover:text-accent-brand" title={t('office.focusActive','Focus Active Agent')}><Crosshair size={14}/></button>
      </div>
      <div className="flex items-center gap-1 bg-bg-primary/80 backdrop-blur-sm rounded-lg border border-border-default px-2 py-1">
        {OFFICE_LAYOUT.areas.map((a) => (
          <button key={a.id} onClick={() => handleZoneJump(a.id)} className="p-1 rounded hover:bg-bg-secondary text-text-tertiary hover:text-text-primary flex items-center gap-1" title={a.name}>
            {a.kind==='lobby'?<Navigation size={11}/>:a.kind==='coding'?<Monitor size={11}/>:a.kind==='planning'?<Building2 size={11}/>:a.kind==='tooling'?<Crosshair size={11}/>:a.kind==='review'?<Eye size={11}/>:<Eye size={11}/>}
            <span className="text-[9px] font-mono hidden sm:inline">{a.name.split('/')[0].trim()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
