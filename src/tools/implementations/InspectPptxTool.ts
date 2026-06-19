import { existsSync } from 'fs';
import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { extractPptxPreviewModel } from './office/OfficePreviewExtractor.js';
import { resolveWorkspacePath } from './utils.js';

const InspectPptxSchema = z.object({
  path: z.string().describe('PPTX file path'),
  slide: z.number().int().min(1).optional().describe('1-based slide index; omit for all slides'),
  include_empty: z.boolean().default(false).describe('include elements with no extracted text'),
});

export class InspectPptxTool extends Tool {
  readonly name = 'inspect_pptx';
  readonly description = 'Inspect a native PPTX and return stable element IDs, slide numbers, coordinates, text, image/table metadata, page size and theme fonts. Use this before edit_pptx for element_id-based edits.';
  readonly parameters = InspectPptxSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const parsed = InspectPptxSchema.safeParse(args);
    if (!parsed.success) {
      return { success: false, data: null, error: `ERROR: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }

    const input = parsed.data;
    const sourcePath = resolveWorkspacePath(context?.workspace, input.path, context?.sessionId);
    if (!existsSync(sourcePath)) {
      return { success: false, data: null, error: `ERROR: PPTX 不存在: ${sourcePath}` };
    }

    try {
      const model = await extractPptxPreviewModel(sourcePath);
      const pages = input.slide ? model.pages.filter((page) => page.index === input.slide) : model.pages;
      const slidePayloads = pages.map((page) => {
        const elements = page.elements
          .filter((element) => input.include_empty || element.text || ['image', 'table', 'drawing'].includes(element.kind))
          .map((element, index) => {
            const elementId = `pptx:s${page.index}:e${element.sourceId || index + 1}`;
            return {
              id: element.id,
              element_id: elementId,
              slide: page.index,
              sourceId: element.sourceId,
              kind: element.kind,
              type: element.kind,
              name: element.name,
              text: element.text,
              bbox: element.bbox,
              style: element.style,
              relationshipId: element.relationshipId,
              assetId: element.assetId,
              rows: element.rows,
              metadata: element.metadata,
            };
          });
        return {
          id: page.id,
          index: page.index,
          name: page.name,
          entryPath: page.entryPath,
          size: page.size,
          elements,
        };
      });
      return {
        success: true,
        data: {
          format: 'pptx',
          path: sourcePath,
          pageSize: model.pageSize,
          theme: model.theme,
          stats: model.stats,
          warnings: model.warnings,
          slides: slidePayloads,
          elements: slidePayloads.flatMap((slide) => slide.elements),
          assets: model.assets,
          editHint: 'Pass element.element_id to edit_pptx operations such as replace_element_text, move_element, resize_element, set_element_bbox, or delete_element.',
        },
      };
    } catch (error) {
      return { success: false, data: null, error: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

export default InspectPptxTool;
