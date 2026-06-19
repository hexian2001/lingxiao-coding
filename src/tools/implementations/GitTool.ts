import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { RealGitService } from '../../core/git/RealGitService.js';
import { GitPlatformApi } from '../../core/git/GitPlatformApi.js';
import { getConfigValue } from '../../config.js';

const GitToolSchema = z.object({
  action: z.enum([
    'status',         // 查看 git 状态
    'log',            // 查看提交历史
    'diff',           // 查看变更 diff
    'stage',          // 暂存文件
    'unstage',        // 取消暂存
    'commit',         // 提交变更
    'branch_create',  // 创建分支
    'branch_switch',  // 切换分支
    'branch_list',    // 列出所有分支
    'push',           // 推送到远端
    'pull',           // 从远端拉取
    'fetch',          // 获取远端更新
    'create_mr',      // 创建 MR/PR
    'list_mrs',       // 列出 MR/PR
    'merge_mr',       // 合并 MR/PR
  ]).describe('要执行的 git 操作'),

  // commit 相关
  message: z.string().optional().describe('提交消息（commit 操作必填）'),
  amend: z.boolean().optional().describe('修改最后一次提交（默认 false）'),

  // 文件操作
  files: z.array(z.string()).optional().describe('要暂存/取消暂存的文件列表，空列表表示所有文件'),

  // 分支操作
  branch: z.string().optional().describe('分支名称'),
  from: z.string().optional().describe('创建分支时的起点分支（默认当前分支）'),

  // push/pull
  remote: z.string().optional().describe('远端名称（默认 origin）'),
  set_upstream: z.boolean().optional().describe('push 时设置 upstream（默认 false）'),

  // diff
  staged: z.boolean().optional().describe('是否显示已暂存的 diff（默认显示未暂存）'),
  file: z.string().optional().describe('指定文件路径的 diff'),

  // log
  limit: z.number().optional().describe('历史记录条数（默认 20）'),

  // MR/PR 相关
  mr_title: z.string().optional().describe('MR/PR 标题（create_mr 必填）'),
  mr_description: z.string().optional().describe('MR/PR 描述'),
  mr_target: z.string().optional().describe('MR/PR 目标分支'),
  mr_id: z.union([z.string(), z.number()]).optional().describe('MR/PR ID（merge_mr 必填）'),
  mr_draft: z.boolean().optional().describe('是否创建草稿 MR/PR'),
  mr_state: z.enum(['open', 'closed', 'merged', 'all']).optional().describe('list_mrs 的状态过滤'),
});

export class GitTool extends Tool {
  readonly name = 'git';
  readonly description = 'Git 版本控制操作：查看状态、暂存文件、提交、切换分支、推送拉取，以及创建/合并 MR/PR（GitHub/GitLab/Gitea）。注意：不支持 force push 和强制删除远端分支等危险操作。';
  readonly parameters = GitToolSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const params = GitToolSchema.parse(args);
    const workspace = context?.workspace || process.cwd();
    const git = new RealGitService(workspace);

    try {
      switch (params.action) {

        case 'status': {
          const isRepo = await git.isGitRepo();
          if (!isRepo) return { success: false, data: null, error: 'Not a git repository' };
          const status = await git.getStatus();
          const lines: string[] = [`Branch: ${status.branch}`];
          if (status.tracking) lines.push(`Tracking: ${status.tracking} (ahead ${status.ahead}, behind ${status.behind})`);
          if (status.staged.length) lines.push(`Staged (${status.staged.length}): ${status.staged.map(f => `${f.path}[${f.index}]`).join(', ')}`);
          if (status.unstaged.length) lines.push(`Unstaged (${status.unstaged.length}): ${status.unstaged.map(f => `${f.path}[${f.working_dir}]`).join(', ')}`);
          if (status.untracked.length) lines.push(`Untracked (${status.untracked.length}): ${status.untracked.join(', ')}`);
          if (status.conflicted.length) lines.push(`Conflicted (${status.conflicted.length}): ${status.conflicted.join(', ')}`);
          if (status.isClean) lines.push('Working tree clean');
          return { success: true, data: lines.join('\n') };
        }

        case 'log': {
          const logs = await git.getLogs(params.branch, params.limit ?? 20);
          const formatted = logs.map(c => `${c.shortHash} ${c.date} ${c.author}: ${c.message}`).join('\n');
          return { success: true, data: formatted || '(no commits)' };
        }

        case 'diff': {
          const diff = params.file
            ? await git.getFileDiff(params.file, params.staged ?? false)
            : await git.getDiff(params.staged ?? false);
          return { success: true, data: diff || '(no changes)' };
        }

        case 'stage': {
          await git.stageFiles(params.files ?? []);
          return { success: true, data: `Staged: ${params.files?.length ? params.files.join(', ') : 'all files'}` };
        }

        case 'unstage': {
          await git.unstageFiles(params.files ?? []);
          return { success: true, data: `Unstaged: ${params.files?.length ? params.files.join(', ') : 'all files'}` };
        }

        case 'commit': {
          if (!params.message) return { success: false, data: null, error: 'message is required for commit' };
          const hash = await git.commit(params.message, { amend: params.amend });
          return { success: true, data: `Committed: ${hash} — ${params.message}` };
        }

        case 'branch_create': {
          if (!params.branch) return { success: false, data: null, error: 'branch is required for branch_create' };
          await git.createBranch(params.branch, params.from);
          return { success: true, data: `Created and switched to branch: ${params.branch}` };
        }

        case 'branch_switch': {
          if (!params.branch) return { success: false, data: null, error: 'branch is required for branch_switch' };
          await git.switchBranch(params.branch);
          return { success: true, data: `Switched to branch: ${params.branch}` };
        }

        case 'branch_list': {
          const branches = await git.getBranches();
          const formatted = branches.map(b =>
            `${b.current ? '* ' : '  '}${b.name}${b.remote ? ' (remote)' : ''}${b.lastCommitMsg ? ` — ${b.lastCommitMsg}` : ''}`
          ).join('\n');
          return { success: true, data: formatted };
        }

        case 'push': {
          const result = await git.push({
            remote: params.remote,
            branch: params.branch,
            setUpstream: params.set_upstream,
          });
          return { success: true, data: result };
        }

        case 'pull': {
          const result = await git.pull(params.remote, params.branch);
          return { success: true, data: result };
        }

        case 'fetch': {
          await git.fetch();
          return { success: true, data: 'Fetched all remotes' };
        }

        case 'list_mrs': {
          const api = await this.buildPlatformApi(git);
          const mrs = await api.listMRs(params.mr_state ?? 'open');
          const formatted = mrs.map(mr =>
            `#${mr.id} [${mr.state}] ${mr.title}\n  ${mr.sourceBranch} → ${mr.targetBranch}\n  by ${mr.author} | ${mr.url}`
          ).join('\n\n');
          return { success: true, data: formatted || 'No MRs found' };
        }

        case 'create_mr': {
          if (!params.mr_title) return { success: false, data: null, error: 'mr_title is required for create_mr' };
          const status = await git.getStatus();
          const api = await this.buildPlatformApi(git);
          const targetBranch = params.mr_target
            || (getConfigValue('git.default_target_branch') as string)
            || 'main';
          const mr = await api.createMR({
            title: params.mr_title,
            description: params.mr_description,
            sourceBranch: status.branch,
            targetBranch,
            draft: params.mr_draft,
          });
          return { success: true, data: `Created MR #${mr.id}: ${mr.title}\n${mr.url}` };
        }

        case 'merge_mr': {
          if (params.mr_id === undefined) return { success: false, data: null, error: 'mr_id is required for merge_mr' };
          const api = await this.buildPlatformApi(git);
          await api.mergeMR(params.mr_id);
          return { success: true, data: `Merged MR #${params.mr_id}` };
        }

        default:
          return { success: false, data: null, error: `Unknown action: ${String((params as { action: string }).action)}` };
      }
    } catch (err) {
      return { success: false, data: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async buildPlatformApi(git: RealGitService): Promise<GitPlatformApi> {
    const detected = await git.detectPlatformFromRemote();
    const platform = (getConfigValue('git.platform') as string) || 'none';
    const token = (getConfigValue('git.token') as string) || '';
    const apiUrl = (getConfigValue('git.api_url') as string) || '';

    const effectivePlatform = platform !== 'none' ? platform : detected.platform;
    const effectiveApiUrl = apiUrl || detected.apiUrl;

    return new GitPlatformApi({
      platform: effectivePlatform as 'github' | 'gitlab' | 'gitea' | 'none',
      token,
      apiUrl: effectiveApiUrl || undefined,
      owner: detected.owner,
      repo: detected.repo,
    });
  }
}
