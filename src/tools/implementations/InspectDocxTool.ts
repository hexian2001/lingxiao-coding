import { existsSync } from 'fs';
import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { extractDocxPreviewModel } from './office/OfficePreviewExtractor.js';
import { resolveWorkspacePath } from './utils.js';

const InspectDocxSchema = z.object({
  path: z.string().describe('DOCX file path'),
  page: z.number().int().min(1).optional().describe('logical page index; omit for all pages'),
  include_empty: z.boolean().default(false).describe('include empty paragraphs/drawings'),
});

export class InspectDocxTool extends Tool {
  readonly name = 'inspect_docx';
  readonly description = 'Inspect a native DOCX and return stable element IDs for paragraphs, tables and drawings plus logical pages, theme fonts and page size. Use this before edit_docx for element_id-based edits.';
  readonly parameters = InspectDocxSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const parsed = InspectDocxSchema.safeParse(args);
    if (!parsed.success) {
      return { success: false, data: null, error: `ERROR: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }

    const input = parsed.data;
    const sourcePath = resolveWorkspacePath(context?.workspace, input.path, context?.sessionId);
    if (!existsSync(sourcePath)) {
      return { success: false, data: null, error: `ERROR: DOCX 不存在: ${sourcePath}` };
    }

    try {
      const model = await extractDocxPreviewModel(sourcePath);
      let bodyIndex = 0;
      const allPagePayloads = model.pages.map((page) => {
        const elements = page.elements
          .map((element) => {
            const bodyKind = element.kind === 'table' ? 'tbl' : 'p';
            bodyIndex += 1;
            const elementId = `docx:body:${bodyKind}:${bodyIndex}`;
            return {
              id: element.id,
              element_id: elementId,
              page: page.index,
              kind: element.kind,
              type: element.kind,
              text: element.text,
              style: element.style,
              rows: element.rows,
              children: element.children,
              metadata: element.metadata,
            };
          })
          .filter((element) => input.include_empty || element.text || element.children?.length || ['table', 'drawing'].includes(element.kind));
        return {
          id: page.id,
          index: page.index,
          size: page.size,
          elements,
        };
      });
      const pagePayloads = input.page ? allPagePayloads.filter((page) => page.index === input.page) : allPagePayloads;
      return {
        success: true,
        data: {
          format: 'docx',
          path: sourcePath,
          pageSize: model.pageSize,
          theme: model.theme,
          stats: model.stats,
          warnings: model.warnings,
          pages: pagePayloads,
          elements: pagePayloads.flatMap((page) => page.elements),
          assets: model.assets,
          editHint: 'Pass element.element_id to edit_docx operations such as replace_element_text, move_element, set_element_bbox, or delete_element.',
        },
      };
    } catch (error) {
      return { success: false, data: null, error: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

export default InspectDocxTool;
