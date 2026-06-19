import { existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Workspace - 工作区管理器
 * 
 * 负责管理工作区路径和安全文件访问
 * 参考 Python 版本的 Workspace 实现
 */
export class Workspace {
  private rootPath: string;
  private sessionId?: string;

  /**
   * 创建 Workspace 实例
   * 
   * @param sessionId 会话 ID（可选）
   * @param baseWorkspace 基础工作区路径（可选，默认为当前目录）
   */
  constructor(sessionId?: string, baseWorkspace?: string) {
    this.sessionId = sessionId;
    
    if (baseWorkspace) {
      // 与 Python 版对齐：显式传入 baseWorkspace 时直接使用它
      this.rootPath = baseWorkspace;
    } else if (sessionId) {
      // 未显式指定工作区时，退回 session 目录
      this.rootPath = join(process.cwd(), '.lingxiao', 'sessions', sessionId);
    } else {
      // 否则使用当前目录
      this.rootPath = process.cwd();
    }

    // 确保根目录存在
    this.ensureDir(this.rootPath);
  }

  /**
   * 获取工作区根路径
   */
  get path(): string {
    return this.rootPath;
  }

  /**
   * 解析相对路径，防止路径穿越攻击
   * 
   * @param relativePath 相对路径
   * @returns 解析后的绝对路径
   * @throws PermissionError 如果检测到路径穿越
   */
  resolve(relativePath: string): string {
    const resolved = resolve(this.rootPath, relativePath);
    
    // 检查是否尝试逃逸出工作区
    if (!resolved.startsWith(this.rootPath)) {
      throw new PermissionError(`路径逃逸检测：${relativePath}`);
    }

    return resolved;
  }

  /**
   * 确保会话子目录存在
   * 
   * @param sessionId 会话 ID
   * @returns 会话目录路径
   */
  ensureSessionDir(sessionId: string): string {
    const sessionDir = join(this.rootPath, '.lingxiao', 'sessions', sessionId);
    this.ensureDir(sessionDir);
    return sessionDir;
  }

  /**
   * 确保 scratchpad 目录存在
   * 
   * @param sessionId 会话 ID
   * @returns scratchpad 目录路径
   */
  ensureScratchpadDir(sessionId: string): string {
    const scratchpadDir = join(this.rootPath, '.lingxiao', 'sessions', sessionId, 'scratchpad');
    this.ensureDir(scratchpadDir);
    return scratchpadDir;
  }

  /**
   * 确保目录存在（递归创建）
   * 
   * @param dirPath 目录路径
   */
  private ensureDir(dirPath: string): void {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * 获取会话目录
   * 
   * @param sessionId 会话 ID
   * @returns 会话目录路径
   */
  static getSessionDir(sessionId: string, baseWorkspace?: string): string {
    const workspaceRoot = resolve(baseWorkspace || process.cwd());
    return join(workspaceRoot, '.lingxiao', 'sessions', sessionId);
  }

  /**
   * 统一派生当前 session 运行时路径。
   */
  static getSessionArtifactPaths(sessionId: string, baseWorkspace?: string): {
    workspaceRoot: string;
    sessionsRoot: string;
    sessionDir: string;
    scratchpadDir: string;
    contextDir: string;
    implementationsDir: string;
  } {
    const workspaceRoot = resolve(baseWorkspace || process.cwd());
    const sessionsRoot = join(workspaceRoot, '.lingxiao', 'sessions');
    const sessionDir = join(sessionsRoot, sessionId);
    const scratchpadDir = join(sessionDir, 'scratchpad');
    const contextDir = join(sessionDir, 'context');
    const implementationsDir = join(sessionDir, 'implementations');
    return {
      workspaceRoot,
      sessionsRoot,
      sessionDir,
      scratchpadDir,
      contextDir,
      implementationsDir,
    };
  }

  /**
   * 获取 scratchpad 文件路径
   * 
   * @param sessionId 会话 ID
   * @param agentName Agent 名称
   * @returns scratchpad 文件路径
   */
  static getScratchpadPath(sessionId: string, agentName: string, baseWorkspace?: string): string {
    const scratchpadDir = this.getScratchpadDir(sessionId, baseWorkspace);
    return join(scratchpadDir, `${agentName}.md`);
  }

  /**
   * 获取 scratchpad 目录
   * 
   * @param sessionId 会话 ID
   * @returns scratchpad 目录路径
   */
  static getScratchpadDir(sessionId: string, baseWorkspace?: string): string {
    return this.getSessionArtifactPaths(sessionId, baseWorkspace).scratchpadDir;
  }

  static getContextDir(sessionId: string, baseWorkspace?: string): string {
    return this.getSessionArtifactPaths(sessionId, baseWorkspace).contextDir;
  }
}

/**
 * 路径穿越错误
 */
class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

export default Workspace;
