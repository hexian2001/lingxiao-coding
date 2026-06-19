/**
 * ProcessSelfProtection — 进程信号安全防护
 *
 * 始终启用的底线守卫，不依赖 hardened mode 配置。
 *
 * 设计原则（确定性，非关键词黑名单）：
 *   信号类命令（kill / pkill / killall）必须以**字面数字 PID** 枚举目标。
 *   任何在运行时解析目标、按模式匹配、或针对进程组的，一律拦截——
 *   因为这类命令无法静态证明只杀目标，可能误杀全系统进程（"杀光所有"）。
 *
 * 这条单一谓词结构性覆盖所有绕过路径，不枚举任何进程发现工具名：
 *   - pkill / killall（模式匹配选择器，非字面 PID）
 *   - kill $(...) / 反引号 / $变量 / ${...}（运行时解析）
 *   - ... | xargs kill / xargs kill ...（从 stdin 运行时喂 PID）
 *   - find ... -exec kill ... {}（{} 占位符运行时替换）
 *   - kill -1 / kill -- -PGID / kill -<负数>（进程组 / 杀全部）
 *   - kill $PPID / kill $$ / /proc/.../ppid（自杀/杀父）
 *
 * 放行：
 *   - kill <字面正数 PID>（agent 可管理任意明确进程，含重启外部 dev server）
 *   - kill -0（仅探活，无副作用）
 *   - kill -l（列信号名）/ kill 无目标（无害）
 *   - 纯只读探查：ps / lsof / pgrep（非信号命令，快速路径放行）
 *
 * 例外：protectedPids（主进程 + worker 子进程）即便以字面 PID 命中也拦截——
 * 这些核心进程有专用停止机制（stop_agent / graceful shutdown）。
 */

const protectedPids = new Set<number>();

// ─── 注册 API ────────────────────────────────────────

/** 启动时注册主进程 */
export function registerMainProcess(): void {
  protectedPids.add(process.pid);
}

/** Worker 子进程启动时注册 */
export function registerProtectedPid(pid: number): void {
  if (Number.isInteger(pid) && pid > 0) {
    protectedPids.add(pid);
  }
}

/** Worker 退出时注销 */
export function unregisterProtectedPid(pid: number): void {
  protectedPids.delete(pid);
}

/** 获取当前受保护 PID 集合（测试用） */
export function getProtectedPids(): ReadonlySet<number> {
  return protectedPids;
}

/** 重置（仅测试用） */
export function _resetForTest(): void {
  protectedPids.clear();
}

// ─── 命令检测 ────────────────────────────────────────

/**
 * 信号类命令关键词：kill / pkill / killall。
 * \b 词边界确保 "skill" 等含 kill 子串的词不误匹配；pkill/killall 作为独立词独立捕获
 * （旧的 /\bkill\b/ 会漏过 pkill/killall，导致广播杀在默认非加固安装下畅行）。
 */
const SIGNAL_COMMAND_RE = /\b(killall|pkill|kill)\b/i;

/** 广播式 / 运行时解析的进程杀灭统一拦截文案（遵循 rejection-must-guide） */
const BROADCAST_KILL_ERROR =
  'ERROR: 禁止广播式或运行时解析的进程杀灭（pkill/killall/kill $(...)/xargs kill/{}/$变量）。' +
  '这类命令无法静态证明只杀目标进程，可能误杀全系统进程。' +
  '改用显式数字 PID（如 kill 12345），或用 terminal_control(action=kill, terminal_id=...) 优雅停止你启动的后台终端。';

/** 进程组 / "杀全部" 惯法文案 */
const PROCESS_GROUP_ERROR =
  'ERROR: 禁止杀死进程组或全部进程（kill -1 / 负 PID / kill -- -PGID）。这会终止大量无关进程。' +
  '改用显式的单个正数 PID。';

/**
 * 检测命令是否试图以不安全方式发送进程信号。
 * 返回 null 表示安全，返回错误描述字符串表示拦截。
 *
 * 此函数始终启用，不受 hardened mode 开关控制。
 */
export function validateCommandForProcessKill(command: string): string | null {
  // 空命令放行
  if (!command || !command.trim()) return null;

  const normalized = command.trim();

  // 不含信号类关键词的命令直接放行（快速路径）
  if (!SIGNAL_COMMAND_RE.test(normalized)) return null;

  // 拆分 pipeline / 复合命令中的每条子命令
  const segments = splitCommandSegments(normalized);

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!SIGNAL_COMMAND_RE.test(trimmed)) continue;

    const result = analyzeSignalSegment(trimmed);
    if (result) return result;
  }

  return null;
}

// ─── 内部实现 ────────────────────────────────────────

/** 拆分复合命令为独立执行段（按 ;、&&、||、| 拆分，保留引号内容） */
function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === '\\') {
      current += ch;
      escape = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (ch === ';' || ch === '|' || ch === '&') {
        if (current.trim()) segments.push(current);
        current = '';
        // 跳过连续的 && 或 ||
        if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
          i++;
        }
        continue;
      }
    }

    current += ch;
  }

  if (current.trim()) segments.push(current);
  return segments;
}

/**
 * 分析单条含信号类命令的段。返回拦截原因或 null（安全）。
 *
 * 判定优先级见文件头注释；核心是"目标必须可静态证明为字面正数 PID"。
 */
function analyzeSignalSegment(segment: string): string | null {
  // ─── 1. pkill / killall：模式匹配选择器，永远非字面 PID ───
  if (/\b(pkill|killall)\b/i.test(segment)) {
    return BROADCAST_KILL_ERROR;
  }

  // ─── 2. 信号 0 探活（kill -0 ...）：无副作用，放行 ───
  if (isSignalZero(segment)) return null;

  // ─── 3. 段内含 xargs + kill：从 stdin 运行时喂 PID ───
  // 进入此处说明段含 kill（SIGNAL_COMMAND_RE 已匹配），故只需再判 xargs
  if (/\bxargs\b/i.test(segment)) {
    return BROADCAST_KILL_ERROR;
  }

  // ─── 4. kill $PPID / $$ / ${PPID}：杀父/自杀 ───
  if (/\bkill\b[^;|&]*\$(\$|PPID|\{PPID\}|\{?\$\}?)/.test(segment)) {
    return 'ERROR: 禁止杀死父进程/自身（kill $PPID / kill $$）。此操作会终止整个系统。';
  }

  // ─── 5. 经 /proc 取父 PID 后杀 ───
  if (/\bkill\b[^;|&]*\/proc\/(self\/)?ppid/i.test(segment)) {
    return 'ERROR: 禁止通过 /proc 获取父进程 PID 后杀死。';
  }

  // ─── 6/7/8. 取 kill 目标区做字面性 / 进程组 / 受保护 PID 判定 ───
  const targetArea = getKillTargetArea(segment);

  // 无目标（kill -l / kill 无参数）→ 无害放行
  if (!targetArea.trim()) return null;

  // ─── 6. 运行时解析：$ / 反引号 / {} 占位符 ───
  if (targetArea.includes('$') || targetArea.includes('`') || targetArea.includes('{}')) {
    return BROADCAST_KILL_ERROR;
  }

  // ─── 7. 进程组 / 杀全部：负数字面目标（-1 / -PGID）───
  if (/(^|\s)-\d+/.test(targetArea)) {
    return PROCESS_GROUP_ERROR;
  }

  // ─── 8. 字面 PID 命中受保护集合（leader + worker 核心）───
  if (protectedPids.size > 0) {
    for (const pid of extractNumericPids(segment)) {
      if (protectedPids.has(pid)) {
        return `ERROR: 禁止杀死受保护进程 (PID ${pid})。该进程为系统核心组件。`;
      }
    }
  }

  // ─── 9. 字面正数 PID，安全 ───
  return null;
}

/**
 * 判断 kill 命令是否仅发送信号 0（探活检测，无副作用）
 */
function isSignalZero(segment: string): boolean {
  // kill -0 / kill -s 0 / kill --signal 0
  return /\bkill\s+(-0\b|-s\s+0\b|--signal\s+0\b)/.test(segment);
}

/**
 * 取 kill 命令的目标区：去掉 `kill` 关键词与单个前导信号旗标后的部分。
 *
 * kill [-SIGNAL] pid1 pid2 ...     → "pid1 pid2 ..."
 * kill -s SIGNAL pid ...            → "pid ..."
 * kill --signal SIGNAL pid ...      → "pid ..."
 * kill -9 -1                        → "-1"          （负数目标 = 进程组）
 * kill -l                           → ""            （列信号，无目标）
 *
 * 信号只能是 kill 的第一个参数，故只剥离一个前导旗标，避免误剥负数目标。
 */
function getKillTargetArea(segment: string): string {
  const killMatch = segment.match(/\bkill\b\s*(.*)/i);
  if (!killMatch) return '';
  let args = killMatch[1];
  // 逐一尝试剥离单个前导信号旗标（互斥，按最具体优先）
  args = args.replace(/^--signal\s+\S+\s*/i, '');
  args = args.replace(/^-s\s+\S+\s*/i, '');
  args = args.replace(/^-[a-zA-Z0-9]+\s*/, '');
  return args;
}

/**
 * 从 kill 命令目标区提取显式的正数字 PID 参数。
 */
function extractNumericPids(segment: string): number[] {
  const targetArea = getKillTargetArea(segment);
  const pids: number[] = [];
  for (const token of targetArea.split(/\s+/)) {
    if (/^\d+$/.test(token)) {
      const pid = parseInt(token, 10);
      if (pid > 0) pids.push(pid);
    }
  }
  return pids;
}
