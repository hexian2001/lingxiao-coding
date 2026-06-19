import { z } from 'zod';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { resolveTaskWritePath, resolveWorkspacePath } from './utils.js';
import {
  applyDocxNativeComments,
  applyDocxTrackedRevisions,
  compareOfficeFiles,
  createOfficeReviewManifest,
  writeReviewArtifact,
} from './office/OfficeReview.js';

const ReviewCommentSchema = z.object({
  author: z.string().min(1).max(120),
  severity: z.enum(['info', 'minor', 'major', 'critical']).optional(),
  status: z.enum(['open', 'resolved']).optional(),
  comment: z.string().min(1).max(4000),
  anchor: z.object({
    element_id: z.string().optional(),
    page: z.number().int().min(1).optional(),
    slide: z.number().int().min(1).optional(),
    text: z.string().optional(),
  }).optional(),
});

const OfficeReviewSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('compare'),
    before_path: z.string(),
    after_path: z.string(),
    output_path: z.string().optional().describe('optional JSON artifact path for the compare result'),
  }),
  z.object({
    action: z.literal('create_review_manifest'),
    target_path: z.string(),
    comments: z.array(ReviewCommentSchema).min(1).max(200),
    output_path: z.string().optional().describe('optional JSON artifact path; defaults next to target file'),
  }),
  z.object({
    action: z.literal('apply_docx_comments'),
    target_path: z.string(),
    output_path: z.string().optional().describe('output DOCX path; defaults to <target>.comments.docx'),
    comments: z.array(ReviewCommentSchema.extend({
      initials: z.string().max(8).optional(),
      anchor: z.object({
        element_id: z.string().optional(),
        page: z.number().int().min(1).optional(),
        slide: z.number().int().min(1).optional(),
        text: z.string().optional(),
      }),
    })).min(1).max(100),
  }),
  z.object({
    action: z.literal('apply_docx_revisions'),
    target_path: z.string(),
    output_path: z.string().optional().describe('output DOCX path; defaults to <target>.revisions.docx'),
    revisions: z.array(z.object({
      element_id: z.string().min(1),
      target_text: z.string().min(1).optional().describe('optional exact text inside the element to replace with native w:del/w:ins; enables table-cell and run-level tracked revisions'),
      replacement_text: z.string(),
      author: z.string().min(1).max(120),
      initials: z.string().max(8).optional(),
    })).min(1).max(100),
  }),
]);

export class OfficeReviewTool extends Tool {
  readonly name = '__office_delegate_review';
  readonly description = 'Office review loop tool. Compare DOCX/PPTX/PDF/HTML/text versions, create auditable review manifests, and write native Word comments/tracked revisions with element_id and optional target_text anchors.';
  readonly parameters = OfficeReviewSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const parsed = OfficeReviewSchema.safeParse(args);
    if (!parsed.success) {
      return { success: false, data: null, error: `ERROR: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }

    try {
      const input = parsed.data;
      if (input.action === 'compare') {
        const beforePath = resolveWorkspacePath(context?.workspace, input.before_path, context?.sessionId);
        const afterPath = resolveWorkspacePath(context?.workspace, input.after_path, context?.sessionId);
        if (!existsSync(beforePath)) return { success: false, data: null, error: `ERROR: before_path 不存在: ${beforePath}` };
        if (!existsSync(afterPath)) return { success: false, data: null, error: `ERROR: after_path 不存在: ${afterPath}` };
        const result = await compareOfficeFiles(beforePath, afterPath);
        const outputPath = input.output_path
          ? writeReviewArtifact(resolveTaskWritePath(context?.workspace, input.output_path, context?.sessionId, context?.taskWriteScope), result)
          : undefined;
        return { success: true, data: outputPath ? { ...result, path: resolve(outputPath) } : result };
      }

      if (input.action === 'create_review_manifest') {
        const targetPath = resolveWorkspacePath(context?.workspace, input.target_path, context?.sessionId);
        if (!existsSync(targetPath)) return { success: false, data: null, error: `ERROR: target_path 不存在: ${targetPath}` };
        const manifest = createOfficeReviewManifest(targetPath, input.comments);
        const defaultPath = `${targetPath}.review.json`;
        const outputPath = writeReviewArtifact(
          resolveTaskWritePath(context?.workspace, input.output_path || defaultPath, context?.sessionId, context?.taskWriteScope),
          manifest,
        );
        return { success: true, data: { ...manifest, path: resolve(outputPath) } };
      }

      if (input.action === 'apply_docx_comments') {
        const targetPath = resolveWorkspacePath(context?.workspace, input.target_path, context?.sessionId);
        if (!existsSync(targetPath)) return { success: false, data: null, error: `ERROR: target_path 不存在: ${targetPath}` };
        const outputPath = resolveTaskWritePath(
          context?.workspace,
          input.output_path || targetPath.replace(/\.docx$/i, '.comments.docx'),
          context?.sessionId,
          context?.taskWriteScope,
        );
        const result = await applyDocxNativeComments({ targetPath, outputPath, comments: input.comments });
        return reviewApplyResult(result.comments?.length ?? 0, input.comments.length, { ...result, path: resolve(outputPath) }, 'DOCX comments');
      }

      const targetPath = resolveWorkspacePath(context?.workspace, input.target_path, context?.sessionId);
      if (!existsSync(targetPath)) return { success: false, data: null, error: `ERROR: target_path 不存在: ${targetPath}` };
      const outputPath = resolveTaskWritePath(
        context?.workspace,
        input.output_path || targetPath.replace(/\.docx$/i, '.revisions.docx'),
        context?.sessionId,
        context?.taskWriteScope,
      );
      const result = await applyDocxTrackedRevisions({ targetPath, outputPath, revisions: input.revisions });
      return reviewApplyResult(result.revisions?.length ?? 0, input.revisions.length, { ...result, path: resolve(outputPath) }, 'DOCX revisions');
    } catch (error) {
      return { success: false, data: null, error: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

function reviewApplyResult(appliedCount: number, requestedCount: number, data: Record<string, unknown>, label: string): ToolResult {
  if (requestedCount > 0 && appliedCount < requestedCount) {
    const warnings = Array.isArray(data.warnings) ? data.warnings.filter((item): item is string => typeof item === 'string') : [];
    const failure = appliedCount === 0 ? 'none were applied' : `only ${appliedCount} were applied`;
    return {
      success: false,
      data,
      error: `${label} requested ${requestedCount} change(s), but ${failure}${warnings.length > 0 ? `: ${warnings.join('; ')}` : ''}`,
    };
  }
  return { success: true, data };
}

export default OfficeReviewTool;
