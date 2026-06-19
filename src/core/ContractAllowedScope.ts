/**
 * 契约结构化允许面(Contract Allowed Scope)
 *
 * 把契约从"渲染进 system prompt 的软约束"升级为"写工具执行前的硬校验"。
 * 复用既有 `isPathInside`(utils.ts,带分隔符边界)做目录前缀判定,零新依赖。
 *
 * intersect 语义(只缩不放):写工具最终允许面 = taskWriteScope ∩ allow − forbid。
 * 契约层永远不可能放行 allowedRoots 之外的路径。
 *
 * undefined vs { allow: [] } 的严格区分:
 *  - undefined(契约未声明 allowedScope)= 维持现状,向后兼容,强制层不激活
 *  - { allow: [] }            = 契约明确声明"本任务只读不改",写工具全拒
 *
 * 作为纯类型定义独立成文件,避免 types.ts ↔ ContractPack.ts 的循环依赖(两者都要引用)。
 */
export interface ContractAllowedScope {
  /**
   * 允许写入/创建的目录前缀(绝对路径,或相对 workspaceRoot)。
   * 目标路径必须 isPathInside 某个前缀才放行。
   * 空数组 = 收紧到 0(契约声明了允许面但什么都不许改)。
   */
  allow: string[];
  /**
   * 显式禁止的目录前缀(优先于 allow:路径命中 forbid 直接拒,即便也命中 allow)。
   * 典型用途:保护架构核心目录(src/core/blackboard、StateSemantics 等)。
   */
  forbid?: string[];
  /**
   * 是否允许创建新文件(而非只改既有文件)。默认 false(收紧)。
   */
  allowCreate?: boolean;
}

/**
 * 多契约 allowedScope 取交集,用于一个 task 匹配多个契约 surface 时合并约束。
 *
 * 语义(只缩不放):
 *  - allow 取所有契约的交集(只允许所有契约都允许的路径)。
 *  - forbid 取并集(任一契约禁止的路径都禁)。
 *  - allowCreate 取最严(所有契约都允许才允许)。
 *
 * 边界:
 *  - 无契约声明(或 allow 为空)→ 返回 undefined(维持现状,契约硬执行不激活)。
 *  - 契约冲突(各契约 allow 交集为空)→ 返回 {allow:[]}(写入全锁)→ worker 改任何路径都被拒,
 *    必须先升级契约消除冲突——这是正确行为,契约间矛盾就该显式暴露而非静默放过。
 */
export function intersectContractScopes(scopes: Array<ContractAllowedScope | undefined>): ContractAllowedScope | undefined {
  const defined = scopes.filter((s): s is ContractAllowedScope => Boolean(s && s.allow.length > 0));
  if (defined.length === 0) return undefined;

  // allow 交集:保留在所有契约 allow 中都出现的路径。
  let allow = [...defined[0].allow];
  for (let i = 1; i < defined.length; i += 1) {
    allow = allow.filter(p => defined[i].allow.includes(p));
  }

  // forbid 并集(去重)。
  const forbidSet = new Set<string>();
  for (const s of defined) {
    for (const f of s.forbid ?? []) forbidSet.add(f);
  }
  const forbid = forbidSet.size > 0 ? Array.from(forbidSet) : undefined;

  // allowCreate 最严:所有契约都显式允许才允许。
  const allowCreate = defined.every(s => s.allowCreate === true) ? true : undefined;

  return {
    allow,
    ...(forbid ? { forbid } : {}),
    ...(allowCreate !== undefined ? { allowCreate } : {}),
  };
}

/**
 * 目录前缀包含判定(带分隔符边界)。
 * 语义同 tools/implementations/utils.ts 的 isPathInside,但本模块自包含实现,
 * 避免 core → tools 跨层依赖。判定为纯布尔几何运算,无阈值/置信度/关键词。
 */
function pathInsidePrefix(child: string, prefix: string): boolean {
  const c = child.replace(/\/+$/, '');
  const p = prefix.replace(/\/+$/, '');
  if (p === '') return true; // 空 prefix = workspace 根,包含一切
  return c === p || c.startsWith(`${p}/`);
}

/**
 * 两组 write_scope 前缀是否"正交"(无任何路径包含关系)。
 * 正交 ⟺ A 的任一前缀与 B 的任一前缀互不包含(双向都不命中)。
 * 空数组(无写面限制) = 可能写任何地方 = 视为与所有人重叠(fail-safe 保守,
 * 绝不把"不限写面"误判为可安全并行)。
 */
function scopesOrthogonal(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  for (const pa of a) {
    for (const pb of b) {
      if (pathInsidePrefix(pa, pb) || pathInsidePrefix(pb, pa)) return false;
    }
  }
  return true;
}

export interface ScopeOrthogonality {
  /** 组内两两正交的 task id 分组(贪心分组,供并发视图提示"可同层并行")。 */
  orthogonalGroups: string[][];
  /** scope 两两重叠的 task id 对(供视图标注需串行/缩窄 scope 的冲突)。 */
  overlaps: Array<[string, string]>;
}

/**
 * 计算一组任务的 write_scope 正交性(确定性,非启发式)。
 *
 * 把"并行度 = scope 正交宽度"这个确定性关系投影给 Leader:
 * 落在同一 orthogonalGroup 内的任务 write_scope 两两正交,可同层并行派发;
 * 出现在 overlaps 中的对 write_scope 重叠,需用 blocked_by 串行或缩窄 scope。
 *
 * 用于 Leader 并发概览视图(LeaderContextBuilder),不做派发 gate——
 * 是否串行化由 Leader 决策,这里只提供确定性信号。
 */
export function computeScopeOrthogonality(
  input: Array<{ id: string; write_scope: string[] }>,
): ScopeOrthogonality {
  const items = input.filter((it) => it && it.id);
  const overlaps: Array<[string, string]> = [];

  // 两两判定重叠
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (!scopesOrthogonal(items[i].write_scope, items[j].write_scope)) {
        overlaps.push([items[i].id, items[j].id]);
      }
    }
  }

  // 贪心分组:以每个未分组任务为种子,吸收所有与当前组两两正交的任务。
  const overlapPair = (x: string, y: string): boolean =>
    overlaps.some(([a, b]) => (a === x && b === y) || (a === y && b === x));
  const orthogonalGroups: string[][] = [];
  const placed = new Set<string>();
  for (const seed of items) {
    if (placed.has(seed.id)) continue;
    const group: string[] = [seed.id];
    placed.add(seed.id);
    for (const cand of items) {
      if (placed.has(cand.id)) continue;
      if (group.every((gid) => !overlapPair(gid, cand.id))) {
        group.push(cand.id);
        placed.add(cand.id);
      }
    }
    orthogonalGroups.push(group);
  }

  return { orthogonalGroups, overlaps };
}
