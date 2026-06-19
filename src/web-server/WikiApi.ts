/**
 * WikiApi — Wiki REST API 处理器
 *
 * 提供 /api/v1/wiki/* 端点
 * generate/update 为 fire-and-forget：立即返回，通过 SSE 推送进度
 */

import { WikiManager } from '../wiki/WikiManager.js';
import { createLLMClient } from '../llm/Client.js';
import { refreshRuntimeConfig } from '../config.js';
import type { WikiGenerationResult, WikiLanguage } from '../wiki/types.js';
import type { EventEmitter, EventMap } from '../core/EventEmitter.js';
import type { DatabaseRepositoryAdapter } from '../core/DatabaseRepositories.js';
import { resolve } from 'path';

type WikiEventName = Extract<keyof EventMap, `wiki:${string}`>;

export type WikiEmitterLike = {
  emit<EventName extends WikiEventName>(event: EventName, payload: EventMap[EventName]): unknown;
};

export interface WikiGenerationOptions {
  sessionId?: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return String(error);
}

function generationFailureMessage(result: WikiGenerationResult): string {
  return result.error ?? '';
}

export class WikiApi {
  private wikiManager: WikiManager;
  private focusedSession: { sessionId: string; workspace?: string } | null = null;
  private emitterUnsubscribes: Array<() => void> = [];

  constructor(emitter: EventEmitter, private repos: DatabaseRepositoryAdapter) {
    this.wikiManager = new WikiManager(emitter, repos.raw);
    this.emitterUnsubscribes.push(emitter.subscribe('session:focus', (payload) => {
      this.focusedSession = {
        sessionId: payload.sessionId,
        workspace: payload.workspace,
      };
    }));
  }

  /**
   * 获取 Wiki 状态
   */
  async getStatus(projectPath: string, lang: string) {
    return this.wikiManager.getStatus(projectPath, this.parseLang(lang));
  }

  /**
   * 触发全量生成 — fire-and-forget
   * 立即返回 { started: true }，进度通过 SSE 事件推送
   */
  async generateWiki(projectPath: string, lang: string, emitter?: WikiEmitterLike, options: WikiGenerationOptions = {}) {
    const wikiLang = this.parseLang(lang);
    const sessionId = this.resolveSessionId(projectPath, options.sessionId);

    // 检查是否已在生成
    if (this.wikiManager.isGenerating(projectPath, wikiLang)) {
      return { started: false, error: 'Wiki generation already in progress' };
    }

    // Fire-and-forget: 异步执行，不 await
    // 使用 wiki_model 或 leader_model（走 ModelManager envKey 路径，兼容自定义模型）
    const cfg = refreshRuntimeConfig();
    const wikiModelId = cfg.llm.wiki_model || cfg.llm.leader_model;
    const llm = createLLMClient(wikiModelId || undefined);
    emitter?.emit('wiki:generation_started', { ...this.scope(projectPath, wikiLang, sessionId) });

    // 不 await — 让生成在后台运行，进度通过 SSE 推送
    this.wikiManager.generateWiki(
      projectPath,
      wikiLang,
      llm,
      (phase, progress, detail) => {
        emitter?.emit('wiki:generation_progress', {
          ...this.scope(projectPath, wikiLang, sessionId),
          phase,
          progress,
          detail,
        });
      },
      (sectionId, sectionTitle, chunk) => {
        emitter?.emit('wiki:generation_stream', {
          ...this.scope(projectPath, wikiLang, sessionId),
          sectionId,
          sectionTitle,
          chunk,
        });
      },
    ).then((res: WikiGenerationResult) => {
      if (res.success) {
        emitter?.emit('wiki:generation_completed', { ...this.scope(projectPath, wikiLang, sessionId), result: res });
      } else {
        emitter?.emit('wiki:generation_failed', { ...this.scope(projectPath, wikiLang, sessionId), error: generationFailureMessage(res) });
      }
    }).catch((err: unknown) => {
      emitter?.emit('wiki:generation_failed', { ...this.scope(projectPath, wikiLang, sessionId), error: errorMessage(err) });
    });

    return { started: true, projectPath, lang: wikiLang, sessionId };
  }

  /**
   * 触发增量更新 — fire-and-forget
   */
  async updateWiki(projectPath: string, lang: string, emitter?: WikiEmitterLike, options: WikiGenerationOptions = {}) {
    const wikiLang = this.parseLang(lang);
    const sessionId = this.resolveSessionId(projectPath, options.sessionId);

    if (this.wikiManager.isGenerating(projectPath, wikiLang)) {
      return { started: false, error: 'Wiki generation already in progress' };
    }

    const cfg2 = refreshRuntimeConfig();
    const wikiModelId2 = cfg2.llm.wiki_model || cfg2.llm.leader_model;
    const llm = createLLMClient(wikiModelId2 || undefined);
    emitter?.emit('wiki:generation_started', { ...this.scope(projectPath, wikiLang, sessionId) });

    this.wikiManager.updateWiki(
      projectPath,
      wikiLang,
      llm,
      (phase, progress, detail) => {
        emitter?.emit('wiki:generation_progress', {
          ...this.scope(projectPath, wikiLang, sessionId),
          phase,
          progress,
          detail,
        });
      },
      (sectionId, sectionTitle, chunk) => {
        emitter?.emit('wiki:generation_stream', {
          ...this.scope(projectPath, wikiLang, sessionId),
          sectionId,
          sectionTitle,
          chunk,
        });
      },
    ).then((res: WikiGenerationResult) => {
      if (res.success) {
        emitter?.emit('wiki:generation_completed', { ...this.scope(projectPath, wikiLang, sessionId), result: res });
      } else {
        emitter?.emit('wiki:generation_failed', { ...this.scope(projectPath, wikiLang, sessionId), error: generationFailureMessage(res) });
      }
    }).catch((err: unknown) => {
      emitter?.emit('wiki:generation_failed', { ...this.scope(projectPath, wikiLang, sessionId), error: errorMessage(err) });
    });

    return { started: true, projectPath, lang: wikiLang, sessionId };
  }

  /**
   * 删除 Wiki
   */
  async deleteWiki(projectPath: string, lang?: string) {
    return this.wikiManager.deleteWiki(projectPath, lang ? this.parseLang(lang) : undefined);
  }

  /**
   * 列出文档
   */
  async listDocuments(projectPath: string, lang: string) {
    return this.wikiManager.listDocuments(projectPath, this.parseLang(lang));
  }

  /**
   * 读取文档
   */
  async readDocument(projectPath: string, lang: string, docPath: string) {
    return this.wikiManager.readDocument(projectPath, this.parseLang(lang), docPath);
  }

  /**
   * 检查更新
   */
  async checkForUpdates(projectPath: string, lang: string) {
    return this.wikiManager.checkForUpdates(projectPath, this.parseLang(lang));
  }

  /**
   * Git 同步
   */
  async syncFromGit(projectPath: string, lang: string) {
    return this.wikiManager.syncFromGit(projectPath, this.parseLang(lang));
  }

  /**
   * 查询断点续传状态
   */
  async getCheckpoint(projectPath: string, lang: string): Promise<{ exists: boolean; completedCount: number; totalCount: number }> {
    return this.wikiManager.getCheckpointStatus(projectPath, this.parseLang(lang));
  }

  private parseLang(lang?: string): WikiLanguage {
    if (lang === 'en') return 'en';
    return 'zh'; // 默认中文
  }

  private scope(projectPath: string, lang: WikiLanguage, sessionId?: string) {
    return sessionId ? { sessionId, projectPath, lang } : { projectPath, lang };
  }

  private resolveSessionId(projectPath: string, explicitSessionId?: string): string | undefined {
    if (explicitSessionId?.trim()) return explicitSessionId.trim();

    const focused = this.focusedSession;
    if (focused?.sessionId && this.workspaceMatchesProject(focused.workspace, projectPath)) {
      return focused.sessionId;
    }

    try {
      const focusedSession = focused?.sessionId ? this.repos.sessions.get(focused.sessionId) : null;
      if (focusedSession && this.workspaceMatchesProject(focusedSession.workspace, projectPath)) {
        return focusedSession.id;
      }

      const sessions = this.repos.sessions.list();
      const projectSessions = sessions.filter((session) => (
        session.status !== 'deleted' && this.workspaceMatchesProject(session.workspace, projectPath)
      ));
      const activeSession = projectSessions.find((session) => session.status === 'active');
      return activeSession?.id ?? projectSessions[0]?.id;
    } catch {
      return undefined;
    }
  }

  private workspaceMatchesProject(workspace: string | undefined, projectPath: string): boolean {
    if (!workspace) return false;
    if (workspace === projectPath) return true;
    try {
      return resolve(workspace) === resolve(projectPath);
    } catch {
      return false;
    }
  }
}
