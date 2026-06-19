/**
 * PTY 模块加载器 — 优先使用 @lydell/node-pty，回退到 node-pty，最终回退到 child_process
 */

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize?(cols: number, rows: number): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): void;
  kill(signal?: string): void;
}

export interface PtyModule {
  spawn(file: string, args: string[], options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: NodeJS.ProcessEnv | Record<string, string>;
  }): PtyProcess;
}

export type PtyImplementation = {
  module: PtyModule;
  name: 'lydell-node-pty' | 'node-pty';
} | null;

let cachedPty: PtyImplementation | null | undefined = undefined;

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function shouldDisablePty(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isTruthyEnv(env.LINGXIAO_DISABLE_PTY)) return true;
  if (isTruthyEnv(env.LINGXIAO_ENABLE_PTY_IN_CI)) return false;
  return isTruthyEnv(env.CI);
}

/**
 * 获取 PTY 模块（带缓存）
 *
 * 尝试顺序：
 * 1. @lydell/node-pty (qwen-code 使用的 fork)
 * 2. node-pty (官方包)
 * 3. 返回 null (将回退到 child_process)
 */
export const getPty = async (): Promise<PtyImplementation> => {
  if (shouldDisablePty()) {
    return null;
  }

  if (cachedPty !== undefined) {
    return cachedPty;
  }

  try {
    const lydell = '@lydell/node-pty';
    const module = await import(lydell);
    cachedPty = { module, name: 'lydell-node-pty' };
    return cachedPty;
  } catch {/* swallowed: unhandled error */
    try {
      const nodePty = 'node-pty';
      const module = await import(nodePty);
      cachedPty = { module, name: 'node-pty' };
      return cachedPty;
    } catch {/* swallowed: unhandled error */
      cachedPty = null;
      return null;
    }
  }
};

/**
 * 重置 PTY 缓存（用于测试）
 */
export const resetPtyCache = (): void => {
  cachedPty = undefined;
};
