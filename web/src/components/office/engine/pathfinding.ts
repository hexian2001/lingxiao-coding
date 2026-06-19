/**
 * A* 寻路
 */
import type { TileMap } from '../engine/TileMap.js';

interface Point { x: number; y: number }
interface Node extends Point { f: number; g: number; h: number; parent: Node | null; }

function heuristic(a: Point, b: Point): number { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }

export function findPath(map: TileMap, sx: number, sy: number, ex: number, ey: number): Point[] | null {
  if (!map.isWalkable(ex, ey)) return null;
  const open: Node[] = [], closed = new Set<string>();
  const start: Node = { x: sx, y: sy, f: 0, g: 0, h: heuristic({ x: sx, y: sy }, { x: ex, y: ey }), parent: null };
  open.push(start);
  while (open.length > 0) {
    open.sort((a, b) => a.f - b.f);
    const current = open.shift()!;
    const key = `${current.x},${current.y}`;
    if (current.x === ex && current.y === ey) {
      const path: Point[] = [];
      let node: Node | null = current;
      while (node) { path.unshift({ x: node.x, y: node.y }); node = node.parent; }
      return path.slice(1);
    }
    closed.add(key);
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nx = current.x + dx, ny = current.y + dy;
      const nk = `${nx},${ny}`;
      if (closed.has(nk)) continue;
      if (!map.isWalkable(nx, ny)) continue;
      const g = current.g + 1, h = heuristic({ x: nx, y: ny }, { x: ex, y: ey });
      const f = g + h;
      const existing = open.find(n => n.x === nx && n.y === ny);
      if (existing) { if (g < existing.g) { existing.g = g; existing.f = f; existing.parent = current; } }
      else open.push({ x: nx, y: ny, f, g, h, parent: current });
      if (open.length > 500) return null; // safety
    }
  }
  return null;
}
