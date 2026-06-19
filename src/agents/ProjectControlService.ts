import type { DatabaseManager } from '../core/Database.js';
import { ProjectRuntimeManager } from '../core/ProjectRuntimeManager.js';
import { EternalRuntimeTelemetry } from '../core/EternalRuntimeTelemetry.js';

export type ProjectControlAction =
  | 'pause'
  | 'resume'
  | 'reprioritize'
  | 'force_replan'
  | 'force_reset'
  | 'resolve_dependency'
  | 'archive';

export class ProjectControlService {
  private db: DatabaseManager;
  private runtimeManager: ProjectRuntimeManager;
  private telemetry: EternalRuntimeTelemetry;

  constructor(db: DatabaseManager, workspace: string) {
    this.db = db;
    this.runtimeManager = new ProjectRuntimeManager(workspace);
    this.telemetry = new EternalRuntimeTelemetry(workspace);
  }

  getCurrentProjectId(sessionId: string): string | null {
    const raw = this.db.getSessionState(sessionId, `orchestration_runtime:${sessionId}`);
    if (!raw || typeof raw !== 'string') return null;
    try {
      const parsed = JSON.parse(raw) as { projectId?: string };
      return parsed.projectId || null;
    } catch {/* expected: operation may fail gracefully */
      return null;
    }
  }

  apply(action: ProjectControlAction, input: {
    sessionId: string;
    projectId?: string;
    reason?: string;
    priority?: 'critical' | 'high' | 'normal' | 'low';
    dependencyId?: string;
  }): string {
    const projectId = input.projectId || this.getCurrentProjectId(input.sessionId);
    if (!projectId) {
      return '当前没有可控制的 orchestration 项目';
    }

    switch (action) {
      case 'pause':
        this.runtimeManager.setProjectMode(projectId, 'idle', {
          actor: 'operator',
          type: 'operator_pause',
          summary: input.reason || 'Operator paused project',
        });
        this.telemetry.increment(projectId, { projectPaused: 1 });
        this.telemetry.recordAudit(projectId, { kind: 'control', summary: 'Project paused by operator', details: input });
        return `已暂停项目 ${projectId}`;
      case 'resume':
        this.runtimeManager.setProjectMode(projectId, 'planning', {
          actor: 'operator',
          type: 'operator_resume',
          summary: input.reason || 'Operator resumed project',
        });
        this.telemetry.increment(projectId, { projectResumed: 1 });
        this.telemetry.recordAudit(projectId, { kind: 'control', summary: 'Project resumed by operator', details: input });
        return `已恢复项目 ${projectId}`;
      case 'reprioritize':
        this.runtimeManager.updateProject(projectId, (record) => {
          record.metadata = { ...(record.metadata || {}), priority: input.priority || 'normal' };
          return record;
        });
        this.telemetry.recordAudit(projectId, { kind: 'control', summary: `Project reprioritized to ${input.priority || 'normal'}`, details: input });
        return `已将项目 ${projectId} 优先级更新为 ${input.priority || 'normal'}`;
      case 'force_replan':
        this.runtimeManager.setProjectMode(projectId, 'replanning', {
          actor: 'operator',
          type: 'operator_force_replan',
          summary: input.reason || 'Operator forced replan',
        });
        this.telemetry.increment(projectId, { replanCount: 1 });
        this.telemetry.recordAudit(projectId, { kind: 'control', summary: 'Project forced into replanning', details: input });
        return `已对项目 ${projectId} 发起强制重规划`;
      case 'force_reset':
        this.runtimeManager.setProjectMode(projectId, 'recovering', {
          actor: 'operator',
          type: 'operator_force_reset',
          summary: input.reason || 'Operator forced context reset',
        });
        this.telemetry.increment(projectId, { resetCount: 1 });
        this.telemetry.recordAudit(projectId, { kind: 'control', summary: 'Project forced into reset/recovery', details: input });
        return `已对项目 ${projectId} 发起强制重置`;
      case 'resolve_dependency':
        if (!input.dependencyId) {
          return '请提供 dependencyId';
        }
        this.runtimeManager.updateDependencyStatus(projectId, input.dependencyId, {
          status: 'fulfilled',
          actor: 'operator',
          summary: input.reason || `Dependency ${input.dependencyId} resolved`,
        });
        this.telemetry.recordAudit(projectId, { kind: 'control', summary: `Dependency ${input.dependencyId} resolved`, details: input });
        return `已将依赖 ${input.dependencyId} 标记为 fulfilled`;
      case 'archive':
        this.runtimeManager.setProjectMode(projectId, 'archived', {
          actor: 'operator',
          type: 'operator_archive',
          summary: input.reason || 'Operator archived project',
        });
        this.telemetry.applyRetention(projectId);
        this.telemetry.recordAudit(projectId, { kind: 'control', summary: 'Project archived', details: input });
        return `已归档项目 ${projectId}`;
      default:
        return '不支持的项目控制动作';
    }
  }
}

export default ProjectControlService;
