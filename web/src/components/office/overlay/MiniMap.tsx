/**
 * MiniMap — 右下角可点击小地图（点击跳转相机）
 */
import { useEffect, useRef, useCallback } from 'react';
import { OFFICE_LAYOUT, TileType } from '../assets/officeLayout';
import { TILE_SIZE } from '../engine/TileMap';
import type { OfficeEngine } from '../engine/OfficeEngine';

const MT = 2, MW = OFFICE_LAYOUT.width * MT, MH = OFFICE_LAYOUT.height * MT;
const TC: Record<TileType, string> = { [TileType.WALL]: '#2d2d44', [TileType.FLOOR]: '#3a3a5c', [TileType.CARPET]: '#2a4a6a', [TileType.DOOR]: '#5a4a3a' };
const AC: Record<string, string> = { lobby: '#3a5a3a', coding: '#3a3a5c', planning: '#5a3a5c', tooling: '#3a5a5c', review: '#5a5a3a', observability: '#3a5a6a' };

interface Props { engine: React.RefObject<OfficeEngine | null>; }

export default function MiniMap({ engine }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    for (let y = 0; y < OFFICE_LAYOUT.height; y++) for (let x = 0; x < OFFICE_LAYOUT.width; x++) {
      const t = OFFICE_LAYOUT.tiles[y][x];
      const a = OFFICE_LAYOUT.areas.find(ar => x >= ar.bounds.x && x < ar.bounds.x + ar.bounds.w && y >= ar.bounds.y && y < ar.bounds.y + ar.bounds.h);
      ctx.fillStyle = a && t !== TileType.WALL ? (AC[a.kind] || TC[t]) : TC[t];
      ctx.fillRect(x * MT, y * MT, MT, MT);
    }
    for (const ws of OFFICE_LAYOUT.workstations) { ctx.fillStyle = '#6688aa'; ctx.fillRect(ws.tileX * MT, ws.tileY * MT, MT, MT); }
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const eng = engine.current; if (!eng?.camera) return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const scaleX = MW / Math.min(MW, 160), scaleY = MH / Math.min(MH, 120);
    const tx = (sx * scaleX) / MT, ty = (sy * scaleY) / MT;
    const wx = tx * TILE_SIZE + TILE_SIZE, wy = ty * TILE_SIZE + TILE_SIZE;
    eng.camera.centerOn(wx, wy);
    eng.camera.setZoom(2);
  }, [engine]);

  return (
    <div className="absolute bottom-14 left-2 z-10 group">
      <canvas ref={ref} width={MW} height={MH} onClick={handleClick}
        className="rounded border border-border-default opacity-60 group-hover:opacity-90 transition-opacity cursor-crosshair"
        style={{ width: Math.min(MW, 160), height: Math.min(MH, 120), imageRendering: 'pixelated' }} />
      <div className="hidden group-hover:block absolute left-full ml-2 top-0 bg-bg-primary/90 backdrop-blur-sm rounded border border-border-default p-1.5 text-[9px] whitespace-nowrap pointer-events-none">
        {OFFICE_LAYOUT.areas.map((area) => (<div key={area.id} className="flex items-center gap-1.5 py-0.5"><span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: AC[area.kind] || '#666' }}/><span className="text-text-secondary">{area.name}</span></div>))}
      </div>
    </div>
  );
}
