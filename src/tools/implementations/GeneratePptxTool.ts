import { z } from 'zod';
import { dirname, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import JSZip from 'jszip';
import type PptxGenJS from 'pptxgenjs';
import { Tool, type ToolContext, type ToolResult } from '../Tool.js';
import { tempDownloadRegistry } from '../../core/TempDownloadRegistry.js';
import { ensureExtension, slugFileName } from './OfficeXmlBuilder.js';
import { resolveTaskWritePath } from './utils.js';
import {
  isOfficeTemplatePresetId,
  officeTemplateMetadata,
  resolveOfficeTemplatePreset,
  type OfficeTemplatePreset,
} from './office/OfficeTemplateRegistry.js';

const PptxImageSchema = z.object({
  path: z.string().describe('本地图片路径'),
  x: z.number().min(0).max(13.333).optional(),
  y: z.number().min(0).max(7.5).optional(),
  w: z.number().min(0.2).max(13.333).optional(),
  h: z.number().min(0.2).max(7.5).optional(),
});

const PptxChartSchema = z.object({
  type: z.enum(['bar', 'line', 'pie', 'doughnut', 'area', 'scatter', 'radar']).default('bar'),
  title: z.string().max(160).optional(),
  labels: z.array(z.string()).min(1).max(80),
  series: z.array(z.object({
    name: z.string().min(1).max(80),
    values: z.array(z.number()).min(1).max(80),
  })).min(1).max(12),
  x: z.number().min(0).max(13.333).default(7.0),
  y: z.number().min(0).max(7.5).default(1.65),
  w: z.number().min(1).max(13.333).default(5.3),
  h: z.number().min(1).max(7.5).default(3.8),
  show_legend: z.boolean().default(true),
  show_values: z.boolean().default(false),
});

const PptxAnimationSchema = z.object({
  target: z.enum(['title', 'subtitle', 'bullets', 'image', 'chart', 'all']).default('all'),
  preset: z.enum(['entrance', 'fade', 'wipe', 'fly_in', 'flyIn', 'appear', 'emphasis']).default('fade'),
  trigger: z.enum(['on_click', 'with_previous', 'after_previous']).default('on_click'),
  duration_ms: z.number().int().min(50).max(10000).default(350),
  delay_ms: z.number().int().min(0).max(60000).default(0),
});

const PptxSlideSchema = z.object({
  title: z.string().min(1).max(180),
  subtitle: z.string().max(260).optional(),
  bullets: z.array(z.string()).max(12).default([]),
  notes: z.string().max(2000).optional(),
  layout: z.enum(['title', 'content', 'two_column', 'section']).default('content'),
  right_bullets: z.array(z.string()).max(8).optional().describe('two_column 布局右侧项目符号'),
  image: PptxImageSchema.optional(),
  chart: PptxChartSchema.optional(),
  animations: z.array(PptxAnimationSchema).max(24).default([]).describe('PPT animation plan persisted as customXml metadata for downstream renderer/OOXML animation pass'),
});

const GeneratePptxSchema = z.object({
  path: z.string().optional().describe('输出 pptx 路径。可省略，默认写入当前 session scratchpad。'),
  title: z.string().min(1).max(200).describe('演示文稿标题，也用于默认文件名'),
  author: z.string().max(120).default('LingXiao'),
  template: z.string().refine(isOfficeTemplatePresetId, '未知模板 preset').optional().describe('模板 preset ID（10 套可选）：lingxiao_board（董事会）、enterprise_report（企业报告）、product_strategy（产品策略）、ink_wash（墨韵极简）、vermilion（朱砂典藏）、cyan_blade（青锋科技）、gold_leaf（金箔商务）、editorial（编辑杂志）、dark_luxury（暗色高级）、papyrus（宣纸纯净）。根据内容性质选择匹配风格，不要默认用同一套。'),
  slides: z.array(PptxSlideSchema).min(1).max(80),
  create_download_link: z.boolean().default(true),
  expires_in_seconds: z.number().optional(),
});

type GeneratePptxInput = z.infer<typeof GeneratePptxSchema>;
type PptxSlideInput = z.infer<typeof PptxSlideSchema>;
type PptxChartInput = z.infer<typeof PptxChartSchema>;
type PptxAnimationInput = z.infer<typeof PptxAnimationSchema>;

const MASTER_NAME = 'LINGXIAO_CORPORATE_MASTER';

export class GeneratePptxTool extends Tool {
  readonly name = 'generate_pptx';
  readonly description = '生成原生可编辑 PPTX 演示文稿。支持标题页、章节页、内容页、双栏页、图片和演讲备注；用于商务汇报、方案、路演、培训等 Office 工作流。';
  readonly parameters = GeneratePptxSchema;

  async execute(args: unknown, context?: ToolContext): Promise<ToolResult> {
    const parsed = GeneratePptxSchema.safeParse(args);
    if (!parsed.success) {
      return { success: false, data: null, error: `ERROR: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }
    const input = parsed.data;
    const defaultName = `${slugFileName(input.title, 'presentation')}.pptx`;
    const requestedPath = input.path || `.lingxiao/sessions/${context?.sessionId || 'default'}/scratchpad/${defaultName}`;

    let outputPath: string;
    try {
      outputPath = ensureExtension(resolveTaskWritePath(context?.workspace, requestedPath, context?.sessionId, context?.taskWriteScope), '.pptx');
    } catch (error) {
      return { success: false, data: null, error: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
    }

    try {
      const PptxGenJS = (await import('pptxgenjs')).default;
      const pptx = new PptxGenJS();
      pptx.layout = 'LAYOUT_WIDE';
      pptx.author = input.author;
      pptx.subject = input.title;
      pptx.title = input.title;
      pptx.company = 'LingXiao';
      const template = resolveOfficeTemplatePreset(input.template);
      pptx.theme = {
        headFontFace: template.themeFonts.heading,
        bodyFontFace: template.themeFonts.body,
      };
      pptx.defineSlideMaster({
        title: MASTER_NAME,
        background: { color: template.slideDefaults.background },
        objects: [
          { rect: { x: 0, y: 0, w: 13.333, h: 0.08, fill: { color: template.palette.accent }, line: { color: template.palette.accent } } },
          { line: { x: 0.62, y: 6.78, w: 11.7, h: 0, line: { color: template.palette.line, width: 0.5 } } },
        ],
      });

      input.slides.forEach((slideInput, index) => {
        const slide = pptx.addSlide({ masterName: MASTER_NAME });
        const palette = template.palette;
        slide.background = { color: slideInput.layout === 'title' ? template.cover.background : template.slideDefaults.background };

        if (slideInput.layout === 'title') {
          this.addCoverSlide(pptx, slide, slideInput, template, input.author);
          this.addSlideChrome(pptx, slide, index, template);
        } else if (slideInput.layout === 'section') {
          this.addSlideChrome(pptx, slide, index, template);
          this.addSectionSlide(pptx, slide, slideInput, template);
        } else {
          this.addSlideChrome(pptx, slide, index, template);
          if (template.content.rule === 'left') {
            slide.addShape(pptx.ShapeType.rect, {
              x: 0.52, y: 0.48, w: 0.08, h: 0.76,
              fill: { color: palette.accent },
              line: { color: palette.accent },
            });
          }
          slide.addText(slideInput.title, {
            x: template.content.rule === 'left' ? 0.76 : 0.62,
            y: template.content.titleTop,
            w: template.content.rule === 'left' ? 11 : 11.5,
            h: 0.42,
            fontFace: template.themeFonts.heading,
            fontSize: template.slideDefaults.titleSize,
            bold: true,
            color: palette.text,
            fit: 'shrink',
          });
          if (slideInput.subtitle) {
            slide.addText(slideInput.subtitle, {
              x: template.content.rule === 'left' ? 0.78 : 0.64,
              y: template.content.titleTop + 0.5,
              w: 10.2,
              h: 0.28,
              fontFace: template.themeFonts.body,
              fontSize: 10,
              color: palette.muted,
              fit: 'shrink',
            });
          }

          const leftW = slideInput.layout === 'two_column' ? 5.55 : 10.9;
          this.addBullets(slide, slideInput.bullets, 0.82, template.content.bodyTop, leftW, 4.9, template);
          if (slideInput.layout === 'two_column') {
            slide.addShape(pptx.ShapeType.rect, {
              x: 6.85, y: template.content.bodyTop - 0.17, w: 5.45, h: 5.05,
              fill: { color: palette.surface },
              line: { color: palette.line, transparency: 15 },
            });
            this.addBullets(slide, slideInput.right_bullets ?? [], 7.15, template.content.bodyTop + 0.13, 4.85, 4.45, template);
          }
        }

        if (slideInput.image?.path && existsSync(slideInput.image.path)) {
          slide.addImage({
            path: slideInput.image.path,
            x: slideInput.image.x ?? 8.2,
            y: slideInput.image.y ?? 1.6,
            w: slideInput.image.w ?? 4.2,
            h: slideInput.image.h ?? 3.1,
          });
        }
        if (slideInput.chart) {
          this.addChart(pptx, slide, slideInput.chart, template);
        }
        if (slideInput.notes) {
          slide.addNotes(slideInput.notes);
        }
      });

      mkdirSync(dirname(outputPath), { recursive: true });
      await pptx.writeFile({ fileName: outputPath });
      const animationCount = input.slides.reduce((sum, slide) => sum + slide.animations.length, 0);
      if (animationCount > 0) {
        await attachAnimationPlanAndNativeTiming(outputPath, input, template);
      }

      const artifact = input.create_download_link
        ? tempDownloadRegistry.create({
          path: outputPath,
          name: defaultName,
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          expiresInSeconds: input.expires_in_seconds,
          sessionId: context?.sessionId,
        })
        : undefined;

      return {
        success: true,
        data: artifact
          ? { ...artifact, slideCount: input.slides.length, animationCount, masterName: MASTER_NAME, ...officeTemplateMetadata(template) }
          : { path: resolve(outputPath), slideCount: input.slides.length, animationCount, masterName: MASTER_NAME, ...officeTemplateMetadata(template) },
      };
    } catch (error) {
      return { success: false, data: null, error: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private addSlideChrome(pptx: PptxGenJS, slide: PptxGenJS.Slide, index: number, template: OfficeTemplatePreset): void {
    const palette = template.palette;
    if (template.content.rule === 'top') {
      slide.addShape(pptx.ShapeType.rect, {
        x: 0,
        y: 0,
        w: 13.333,
        h: 0.11,
        fill: { color: palette.accent },
        line: { color: palette.accent },
      });
    }

    slide.addShape(pptx.ShapeType.line, {
      x: 0.62,
      y: 6.78,
      w: 11.7,
      h: 0,
      line: { color: palette.line, width: 0.5 },
    });
    slide.addText(template.footer.left, {
      x: 0.62,
      y: 6.92,
      w: 4.2,
      h: 0.22,
      fontFace: template.themeFonts.body,
      fontSize: 8,
      color: palette.muted,
      fit: 'shrink',
    });
    slide.addText(template.footer.right, {
      x: 5.1,
      y: 6.92,
      w: 5.2,
      h: 0.22,
      fontFace: template.themeFonts.body,
      fontSize: 8,
      color: palette.muted,
      align: 'right',
      fit: 'shrink',
    });
    if (template.footer.showPageNumber) {
      slide.addText(`${index + 1}`.padStart(2, '0'), {
        x: 12.08,
        y: 6.92,
        w: 0.8,
        h: 0.22,
        fontFace: template.themeFonts.body,
        fontSize: 8,
        color: palette.muted,
        align: 'right',
      });
    }
  }

  private addCoverSlide(pptx: PptxGenJS, slide: PptxGenJS.Slide, slideInput: PptxSlideInput, template: OfficeTemplatePreset, author: string): void {
    const palette = template.palette;
    slide.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 13.333,
      h: 1.02,
      fill: { color: template.cover.accentBand },
      line: { color: template.cover.accentBand },
    });
    slide.addText(template.cover.kicker, {
      x: 0.78,
      y: 0.42,
      w: 4.8,
      h: 0.28,
      fontFace: template.themeFonts.body,
      fontSize: 9,
      bold: true,
      color: palette.inverseText,
      charSpacing: 1.4,
      fit: 'shrink',
    });
    slide.addText(slideInput.title, {
      x: template.cover.titleAlign === 'center' ? 1.4 : 0.8,
      y: 2.12,
      w: template.cover.titleAlign === 'center' ? 10.5 : 11.1,
      h: 1.05,
      fontFace: template.themeFonts.heading,
      fontSize: 34,
      bold: true,
      color: palette.text,
      align: template.cover.titleAlign,
      fit: 'shrink',
    });
    slide.addShape(pptx.ShapeType.line, {
      x: template.cover.titleAlign === 'center' ? 4.15 : 0.82,
      y: 3.93,
      w: template.cover.titleAlign === 'center' ? 5 : 4.9,
      h: 0,
      line: { color: palette.accent2, width: 2 },
    });
    if (slideInput.subtitle) {
      slide.addText(slideInput.subtitle, {
        x: template.cover.titleAlign === 'center' ? 1.8 : 0.82,
        y: 3.22,
        w: template.cover.titleAlign === 'center' ? 9.7 : 10.5,
        h: 0.45,
        fontFace: template.themeFonts.body,
        fontSize: 15,
        color: palette.muted,
        align: template.cover.titleAlign,
        fit: 'shrink',
      });
    }
    slide.addText(`${template.title.eyebrow} | ${author}`, {
      x: 0.82,
      y: 5.86,
      w: 6.4,
      h: 0.26,
      fontFace: template.themeFonts.body,
      fontSize: 9,
      color: palette.muted,
      fit: 'shrink',
    });
    slide.addShape(pptx.ShapeType.rect, {
      x: 11.72,
      y: 1.3,
      w: 0.18,
      h: 4.72,
      fill: { color: palette.accent2, transparency: 5 },
      line: { color: palette.accent2, transparency: 5 },
    });
  }

  private addSectionSlide(pptx: PptxGenJS, slide: PptxGenJS.Slide, slideInput: PptxSlideInput, template: OfficeTemplatePreset): void {
    const palette = template.palette;
    slide.addShape(pptx.ShapeType.rect, {
      x: 0.76,
      y: 1.62,
      w: 0.16,
      h: 2.22,
      fill: { color: palette.accent },
      line: { color: palette.accent },
    });
    slide.addText(slideInput.title, {
      x: 1.16,
      y: 2.45,
      w: 10.2,
      h: 0.72,
      fontFace: template.themeFonts.heading,
      fontSize: 28,
      bold: true,
      color: palette.text,
      fit: 'shrink',
    });
    slide.addShape(pptx.ShapeType.line, {
      x: 1.16,
      y: 3.42,
      w: 4.8,
      h: 0,
      line: { color: palette.accent2, width: 2 },
    });
    if (slideInput.subtitle) {
      slide.addText(slideInput.subtitle, {
        x: 1.18,
        y: 3.72,
        w: 9.4,
        h: 0.4,
        fontFace: template.themeFonts.body,
        fontSize: 13,
        color: palette.muted,
        fit: 'shrink',
      });
    }
  }

  private addBullets(slide: PptxGenJS.Slide, bullets: string[], x: number, y: number, w: number, h: number, template: OfficeTemplatePreset): void {
    if (!bullets.length) return;
    slide.addText(bullets.map((text) => ({ text, options: { bullet: { indent: 14 }, breakLine: true } })), {
      x, y, w, h,
      fontFace: template.themeFonts.body,
      fontSize: template.slideDefaults.bodySize,
      color: template.palette.text,
      breakLine: false,
      fit: 'shrink',
      valign: 'top',
      paraSpaceAfter: 9,
      margin: 0.05,
      bullet: { type: 'bullet' },
    });
  }

  private addChart(pptx: PptxGenJS, slide: PptxGenJS.Slide, chart: PptxChartInput, template: OfficeTemplatePreset): void {
    const chartType = pptx.ChartType[chart.type] || chart.type;
    slide.addChart(chartType, chart.series.map((series) => ({
      name: series.name,
      labels: chart.labels,
      values: series.values,
    })), {
      x: chart.x,
      y: chart.y,
      w: chart.w,
      h: chart.h,
      showTitle: Boolean(chart.title),
      title: chart.title,
      showLegend: chart.show_legend,
      showValue: chart.show_values,
      chartColors: [template.palette.accent, template.palette.accent2, template.palette.muted, template.palette.line],
      catAxisLabelFontFace: template.themeFonts.body,
      valAxisLabelFontFace: template.themeFonts.body,
      valAxisLabelColor: template.palette.muted,
      catAxisLabelColor: template.palette.muted,
    });
  }
}

interface AnimationBinding {
  shapeId: string;
  shapeName: string;
  kind: 'shape' | 'image' | 'chart';
  text?: string;
}

interface ResolvedAnimation {
  target: PptxAnimationInput['target'];
  preset: PptxAnimationInput['preset'];
  trigger: PptxAnimationInput['trigger'];
  duration_ms: number;
  delay_ms: number;
  bindings: AnimationBinding[];
}

interface SlideElementBinding extends AnimationBinding {
  xml: string;
}

async function attachAnimationPlanAndNativeTiming(outputPath: string, input: GeneratePptxInput, template: OfficeTemplatePreset): Promise<void> {
  const zip = await JSZip.loadAsync(readFileSync(outputPath));
  const resolvedSlides = await resolveAnimationBindings(zip, input);
  const plan = {
    schema: 'lingxiao.pptx.animationPlan.v1',
    masterName: MASTER_NAME,
    templateId: template.id,
    slides: resolvedSlides,
  };
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><lx:animationPlan xmlns:lx="https://lingxiao.ai/ooxml/animation-plan" schema="${plan.schema}"><lx:json>${xmlEscape(JSON.stringify(plan))}</lx:json></lx:animationPlan>`;
  zip.file('customXml/item1.xml', xml);

  const contentTypesFile = zip.file('[Content_Types].xml');
  if (contentTypesFile) {
    let contentTypes = await contentTypesFile.async('string');
    if (!contentTypes.includes('PartName="/customXml/item1.xml"')) {
      contentTypes = contentTypes.replace('</Types>', '<Override PartName="/customXml/item1.xml" ContentType="application/xml"/></Types>');
      zip.file('[Content_Types].xml', contentTypes);
    }
  }

  const relFile = zip.file('_rels/.rels');
  if (relFile) {
    let rels = await relFile.async('string');
    if (!rels.includes('customXml/item1.xml')) {
      rels = rels.replace('</Relationships>', `<Relationship Id="${nextRelId(rels)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="customXml/item1.xml"/></Relationships>`);
      zip.file('_rels/.rels', rels);
    }
  }

  writeFileSync(outputPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }));
}

async function resolveAnimationBindings(zip: JSZip, input: GeneratePptxInput): Promise<Array<{ slide: number; layout: string; animations: ResolvedAnimation[] }>> {
  const resolvedSlides: Array<{ slide: number; layout: string; animations: ResolvedAnimation[] }> = [];
  for (let index = 0; index < input.slides.length; index += 1) {
    const slideInput = input.slides[index];
    if (!slideInput.animations.length) continue;
    const slidePath = `ppt/slides/slide${index + 1}.xml`;
    const slideFile = zip.file(slidePath);
    if (!slideFile) continue;
    let slideXml = await slideFile.async('string');
    const elements = parseSlideElements(slideXml);
    const animations = slideInput.animations.map((animation) => ({
      ...animation,
      bindings: resolveAnimationTargets(animation.target, slideInput, elements).map(({ shapeId, shapeName, kind, text }) => ({
        shapeId,
        shapeName,
        kind,
        ...(text ? { text } : {}),
      })),
    })).filter((animation) => animation.bindings.length > 0);
    if (!animations.length) continue;
    slideXml = slideXml.replace(/<p:timing\b[\s\S]*?<\/p:timing>/, '');
    slideXml = slideXml.replace('</p:sld>', `${buildTimingXml(animations)}</p:sld>`);
    zip.file(slidePath, slideXml);
    resolvedSlides.push({ slide: index + 1, layout: slideInput.layout, animations });
  }
  return resolvedSlides;
}

function parseSlideElements(slideXml: string): SlideElementBinding[] {
  const elements: SlideElementBinding[] = [];
  for (const match of slideXml.matchAll(/<p:(sp|pic|graphicFrame)\b[\s\S]*?<\/p:\1>/g)) {
    const kind = match[1] === 'pic' ? 'image' : match[1] === 'graphicFrame' ? 'chart' : 'shape';
    const xml = match[0];
    const cNvPr = xml.match(/<p:cNvPr\b([^>]*)>/)?.[1] ?? '';
    const attrs = parseXmlAttributes(cNvPr);
    const shapeId = attrs.id;
    if (!shapeId || shapeId === '1') continue;
    const text = Array.from(xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)).map((textMatch) => decodeXml(textMatch[1])).join('\n');
    elements.push({
      shapeId,
      shapeName: attrs.name ?? '',
      kind,
      text,
      xml,
    });
  }
  return elements;
}

function resolveAnimationTargets(target: PptxAnimationInput['target'], slide: PptxSlideInput, elements: SlideElementBinding[]): SlideElementBinding[] {
  if (target === 'all') {
    const wanted: SlideElementBinding[] = [];
    for (const subTarget of ['title', 'subtitle', 'bullets', 'image', 'chart'] as const) {
      wanted.push(...resolveAnimationTargets(subTarget, slide, elements));
    }
    return uniqueBindings(wanted);
  }
  if (target === 'chart') return elements.filter((element) => element.kind === 'chart');
  if (target === 'image') return elements.filter((element) => element.kind === 'image');
  if (target === 'title') return findTextBindings(elements, slide.title, 1);
  if (target === 'subtitle') return slide.subtitle ? findTextBindings(elements, slide.subtitle, 1) : [];
  const bulletText = [...slide.bullets, ...(slide.right_bullets ?? [])];
  return elements.filter((element) => element.kind === 'shape' && bulletText.some((bullet) => element.text?.includes(bullet)));
}

function findTextBindings(elements: SlideElementBinding[], text: string, limit: number): SlideElementBinding[] {
  return elements.filter((element) => element.kind === 'shape' && element.text?.includes(text)).slice(0, limit);
}

function uniqueBindings(bindings: SlideElementBinding[]): SlideElementBinding[] {
  const seen = new Set<string>();
  return bindings.filter((binding) => {
    if (seen.has(binding.shapeId)) return false;
    seen.add(binding.shapeId);
    return true;
  });
}

function buildTimingXml(animations: ResolvedAnimation[]): string {
  let nextId = 1;
  const effectNodes = animations.flatMap((animation) => animation.bindings.map((binding) => buildEffectNode(animation, binding, () => nextId++))).join('');
  return `<p:timing><p:tnLst><p:par><p:cTn id="${nextId++}" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="${nextId++}" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${effectNodes}</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
}

function buildEffectNode(animation: ResolvedAnimation, binding: AnimationBinding, nextId: () => number): string {
  const effect = nativeEffect(animation.preset);
  const delay = animation.trigger === 'on_click' ? 'indefinite' : String(animation.delay_ms);
  const nodeType = animation.trigger === 'after_previous' ? 'afterEffect' : animation.trigger === 'with_previous' ? 'withEffect' : 'clickEffect';
  const duration = Math.max(1, animation.duration_ms);
  return `<p:par><p:cTn id="${nextId()}" presetID="${effect.presetID}" presetClass="${effect.presetClass}" presetSubtype="${effect.presetSubtype}" fill="hold" nodeType="${nodeType}"><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst><p:childTnLst><p:set><p:cBhvr><p:cTn id="${nextId()}" dur="1" fill="hold"/><p:tgtEl><p:spTgt spid="${xmlEscape(binding.shapeId)}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set><p:animEffect transition="${effect.transition}" filter="${effect.filter}"><p:cBhvr><p:cTn id="${nextId()}" dur="${duration}" fill="hold"/><p:tgtEl><p:spTgt spid="${xmlEscape(binding.shapeId)}"/></p:tgtEl></p:cBhvr></p:animEffect></p:childTnLst></p:cTn></p:par>`;
}

function nativeEffect(preset: PptxAnimationInput['preset']): { presetID: number; presetClass: 'entr' | 'emph'; presetSubtype: number; transition: 'in' | 'none'; filter: string } {
  if (preset === 'wipe') return { presetID: 22, presetClass: 'entr', presetSubtype: 5, transition: 'in', filter: 'wipe(r)' };
  if (preset === 'fly_in' || preset === 'flyIn') return { presetID: 2, presetClass: 'entr', presetSubtype: 4, transition: 'in', filter: 'flyin(b)' };
  if (preset === 'appear' || preset === 'entrance') return { presetID: 1, presetClass: 'entr', presetSubtype: 0, transition: 'in', filter: 'appear' };
  if (preset === 'emphasis') return { presetID: 1, presetClass: 'emph', presetSubtype: 0, transition: 'none', filter: 'pulse' };
  return { presetID: 10, presetClass: 'entr', presetSubtype: 0, transition: 'in', filter: 'fade' };
}

function parseXmlAttributes(value: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of value.matchAll(/\b([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    attrs[match[1]] = decodeXml(match[2]);
  }
  return attrs;
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number.parseInt(num, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function nextRelId(relsXml: string): string {
  let max = 0;
  for (const match of relsXml.matchAll(/\bId="rId(\d+)"/g)) {
    max = Math.max(max, Number(match[1]) || 0);
  }
  return `rId${max + 1}`;
}

function xmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export default GeneratePptxTool;
