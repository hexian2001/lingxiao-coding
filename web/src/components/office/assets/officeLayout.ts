/**
 * officeLayout — Lingxiao Team Tower (72x48 瓦片，6 功能区，28+ 工位)
 */

export enum TileType { WALL = 0, FLOOR = 1, CARPET = 2, DOOR = 3 }

export type OfficeAreaKind = 'lobby' | 'coding' | 'planning' | 'tooling' | 'review' | 'observability';

export interface OfficeArea {
  id: string; name: string; kind: OfficeAreaKind;
  bounds: { x: number; y: number; w: number; h: number };
  roleAffinity?: string[];
}

export interface FurnitureItem {
  type: 'desk'|'chair'|'plant'|'server'|'whiteboard'|'coffee'|'elevator'|'terminal'|'dashboard'|'conference_table'|'toolbench'|'sofa'|'bookshelf'|'hologram';
  x: number; y: number;
}

export interface Workstation {
  id: string; tileX: number; tileY: number; label?: string;
  areaId?: string; roleAffinity?: string[];
}

export interface OfficeLayoutData {
  width: number; height: number; tiles: TileType[][];
  furniture: FurnitureItem[]; workstations: Workstation[];
  areas: OfficeArea[]; spawnPoint: { x: number; y: number };
}

const W = TileType.WALL, F = TileType.FLOOR, C = TileType.CARPET, D = TileType.DOOR;
const WIDTH = 72, HEIGHT = 48;

const areas: OfficeArea[] = [
  { id:'lobby', name:'Dispatch Hall', kind:'lobby', bounds:{x:2,y:32,w:18,h:12}, roleAffinity:['worker','general'] },
  { id:'coding', name:'Coding Floor', kind:'coding', bounds:{x:2,y:2,w:31,h:27}, roleAffinity:['implement','general','worker','coder'] },
  { id:'planning', name:'War Room', kind:'planning', bounds:{x:37,y:2,w:31,h:13}, roleAffinity:['plan','lead','architect'] },
  { id:'tooling', name:'Tool Lab', kind:'tooling', bounds:{x:37,y:18,w:31,h:12}, roleAffinity:['tool','terminal','debug'] },
  { id:'review', name:'Review Lounge', kind:'review', bounds:{x:23,y:32,w:23,h:12}, roleAffinity:['review','test','qa'] },
  { id:'observability', name:'Observatory', kind:'observability', bounds:{x:49,y:32,w:19,h:12}, roleAffinity:['monitor','observe','status'] },
];

function inA(x:number,y:number,a:OfficeArea){return x>=a.bounds.x&&x<a.bounds.x+a.bounds.w&&y>=a.bounds.y&&y<a.bounds.y+a.bounds.h;}

function buildTiles(): TileType[][] {
  const rows: TileType[][] = [];
  for(let y=0;y<HEIGHT;y++){
    const row: TileType[] = [];
    for(let x=0;x<WIDTH;x++){
      const a = areas.find(ai=>inA(x,y,ai));
      if(!a){row.push(W);continue;}
      const edge = x===a.bounds.x||x===a.bounds.x+a.bounds.w-1||y===a.bounds.y||y===a.bounds.y+a.bounds.h-1;
      row.push(edge?W:(a.kind==='coding'||a.kind==='tooling'?F:C));
    }
    rows.push(row);
  }
  // corridors
  for(let y=30;y<=31;y++) for(let x=2;x<=68;x++) rows[y][x]=F;
  for(let x=33;x<=36;x++) for(let y=2;y<=31;y++) rows[y][x]=F;
  for(let y=15;y<=17;y++) for(let x=37;x<=68;x++) rows[y][x]=F;
  // doors
  const doors = [[16,32],[17,32],[23,32],[24,32],[49,32],[50,32],[33,10],[33,11],[37,10],[37,11],[37,23],[37,24],[33,23],[33,24],[12,29],[13,29],[55,30],[56,30]];
  for(const [x,y] of doors) rows[y][x]=D;
  return rows;
}

function deskCluster(areaId:string,sx:number,sy:number,cols:number,rows:number,prefix:string,aff:string[]):{f:FurnitureItem[];w:Workstation[]}{
  const f:FurnitureItem[]=[],w:Workstation[]=[];
  let idx=1;
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
    const x=sx+c*5, y=sy+r*4;
    f.push({type:'desk',x,y},{type:'chair',x:x+1,y:y+1});
    w.push({id:`${areaId}-${idx}`,tileX:x+1,tileY:y+1,label:`${prefix}${idx}`,areaId,roleAffinity:aff});
    idx++;
  }
  return {f,w};
}

const cp = deskCluster('coding',5,5,5,4,'C',['implement','general','worker','coder']);
const rp = deskCluster('review',26,36,3,2,'R',['review','test','qa']);
const tp = deskCluster('tooling',42,22,4,1,'T',['tool','terminal','debug']);

export const OFFICE_LAYOUT: OfficeLayoutData = {
  width:WIDTH, height:HEIGHT,
  tiles: buildTiles(),
  areas,
  furniture: [
    ...cp.f, ...rp.f, ...tp.f,
    {type:'elevator',x:5,y:35},{type:'dashboard',x:10,y:34},{type:'coffee',x:17,y:40},{type:'plant',x:3,y:33},{type:'plant',x:18,y:33},
    {type:'conference_table',x:44,y:6},{type:'whiteboard',x:39,y:3},{type:'hologram',x:61,y:8},{type:'bookshelf',x:65,y:4},
    {type:'terminal',x:40,y:20},{type:'terminal',x:48,y:20},{type:'toolbench',x:57,y:22},{type:'server',x:64,y:20},{type:'server',x:65,y:20},{type:'server',x:66,y:20},
    {type:'sofa',x:39,y:39},{type:'whiteboard',x:25,y:33},{type:'coffee',x:44,y:34},
    {type:'dashboard',x:53,y:35},{type:'hologram',x:61,y:38},{type:'server',x:66,y:34},{type:'plant',x:50,y:42},
  ],
  workstations: [
    ...cp.w, ...rp.w, ...tp.w,
    {id:'planning-1',tileX:46,tileY:8,label:'P1',areaId:'planning',roleAffinity:['plan','lead']},
    {id:'planning-2',tileX:49,tileY:8,label:'P2',areaId:'planning',roleAffinity:['plan','lead']},
    {id:'planning-3',tileX:52,tileY:8,label:'P3',areaId:'planning',roleAffinity:['plan','lead']},
    {id:'planning-4',tileX:55,tileY:8,label:'P4',areaId:'planning',roleAffinity:['plan','lead']},
    {id:'lobby-1',tileX:8,tileY:38,label:'D1',areaId:'lobby',roleAffinity:['worker','general']},
    {id:'lobby-2',tileX:13,tileY:38,label:'D2',areaId:'lobby',roleAffinity:['worker','general']},
    {id:'observability-1',tileX:55,tileY:39,label:'O1',areaId:'observability',roleAffinity:['monitor','observe']},
    {id:'observability-2',tileX:62,tileY:39,label:'O2',areaId:'observability',roleAffinity:['monitor','observe']},
  ],
  spawnPoint: { x: 8, y: 38 },
};
