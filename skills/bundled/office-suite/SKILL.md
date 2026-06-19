---
name: office-suite
description: Native Office production workflow for PPTX, DOCX, XLSX, PDF, HTML, Markdown, and Canvas. Use when creating, editing, previewing, validating, reviewing, or polishing business documents, decks, spreadsheets, PDFs, templates, comments, revisions, image-heavy office files, or Office/WPS/LibreOffice acceptance loops.
---

# Office Suite

## Rule

Treat Office artifacts as editable engineering deliverables, not one-shot text outputs.

Default loop:

1. Clarify the target format when ambiguous: native PPTX/DOCX/XLSX/PDF, HTML presentation, Markdown, or Canvas.
2. Inspect existing files before edits with `inspect_pptx`, `inspect_docx`, `parse_file`, or `office_ops(action="validate" | "runtime")`.
3. Generate or edit with stable IDs, page/slide numbers, coordinates, text anchors, and explicit output paths.
4. Use Python, LibreOffice, and OOXML scripts when native tools are not enough.
5. Validate structure, expected text, media relationships, page/slide counts, comments/revisions, charts, timing, formulas, and open checks with `office_ops(action="validate", ...)`.
6. Iterate with review artifacts and precise edits until the file is fit for a client.

## Design Philosophy

Office artifacts are design deliverables, not information containers. The following principles are aesthetic gates, not suggestions:

- **Restraint is luxury**: One core message per page, one primary structure, enough visual evidence to support the argument. Reject information dumping. More than 6 bullet points per page is overload.
- **Whitespace is design**: Negative space matters as much as content. Page breathing room takes priority over information density. Margins ≥ 48px, element spacing ≥ 24px.
- **Hierarchy is rhythm**: Four clear levels — title/body/auxiliary/decoration. Font size contrast should be bold (title ≥ 1.5× body). Never one rhythm across the whole page.
- **Color is language**: One primary color + one accent + neutral grays, no more than 3 chromatic colors total. No rainbow palettes, no default blue-white, no high-saturation stacking.
- **Typography is character**: Headings use serif/display fonts for formality, body uses sans-serif for readability. CJK prefers Source Han Serif/PingFang/Microsoft YaHei. Never single-font throughout.
- **Grid is skeleton**: Stable content grid (12-column or golden ratio), unified header/footer/page numbers. No random spacing or arbitrary alignment.
- **Images are evidence**: Images are information carriers, not decoration. Preserve aspect ratio, choose contain/cover, avoid title and evidence zones, add captions/alt text/attribution when needed, and validate media relationships via `office_ops(action="validate")`.

## Aesthetic Red Lines

The following behaviors are strictly prohibited in any Office artifact. Violating any one means do not ship:

- No emoji as content elements or decoration (⚠️ 📊 🚀 💡 ✅ ❌ etc. are all banned). Use typographic hierarchy, color contrast, and geometric elements instead.
- No generic AI layout (centered title + three-column bullets + blue gradient background "ChatGPT style").
- No default blue-white palette (#0066CC + #FFFFFF PowerPoint default style).
- No text-only slides (no visual structure, no charts, no image support — "bullet walls").
- No random spacing and alignment (every element's position must have grid justification).
- No high-saturation rainbow palette (more than 3 high-saturation colors simultaneously).
- No single-font throughout (headings and body must have font contrast).
- No "safe corporate style" as the only option (gray-blue-white trio is not a universal template).

## Template System

10 native presets (OfficeTemplateRegistry) bridge to 8 HTML themes (themes.ts) via `htmlThemeId`. Choose templates by content nature, not by default:

| Preset ID | Style | Use Case |
|-----------|-------|----------|
| `lingxiao_board` | Slate gray + white, restrained | Board briefing / executive meeting |
| `enterprise_report` | Low-saturation blue-gray, Arial | Enterprise report / proposal |
| `product_strategy` | Ink + indigo + amber accent | Product strategy / roadmap |
| `ink_wash` | Ink-wash minimalism, CJK serif | Internal sharing / cultural narrative |
| `vermilion` | Vermilion seal + ink-dark + gold | Annual report / retrospective / collection |
| `cyan_blade` | Cyan glow on dark | Product / tech / data / pitch |
| `gold_leaf` | Warm paper + gold leaf | Proposal / business plan / consulting |
| `editorial` | Magazine layout, large headings, multi-column | Deep report / whitepaper / insight |
| `dark_luxury` | Ink-black + gold accent + whitespace | Brand / strategy / launch event |
| `papyrus` | Minimal presence, pure white | Print / long document / academic / contract |

Use `design_asset` to query theme reference sites for aesthetic calibration when needed.

## Native Routes

- PPTX: use `generate_pptx` for editable decks; inspect before multi-round edits; use `edit_pptx` for text, shape, image, bbox, and OOXML edits; validate slide master/layout relationships, media relationships, charts, and native timing.
- DOCX: use `generate_docx`; inspect paragraphs, tables, and drawings; use `edit_docx` for text/table/layout edits; use `office_ops(action="review", office_action="apply_docx_comments" | "apply_docx_revisions")` for native Word comments and tracked revisions.
- XLSX: use `generate_xlsx` or `edit_xlsx`; keep calculations as formulas; run `office_ops(action="runtime", office_action="xlsx_recalc")` when formulas are present.
- PDF: distinguish text-layer PDFs from image-only/scanned PDFs; use OCR when the text layer is missing; validate page count and expected text only when reliable.
- Canvas/HTML/Markdown: use when the user explicitly wants web-native deliverables or visual reference canvases. Do not silently replace a requested PPTX/DOCX/XLSX with HTML.

## Runtime

Use `office_ops(action="runtime", office_action=...)` for deterministic helper workflows:

- `list`: show bundled runtime paths and capabilities.
- `unpack_ooxml`: unpack DOCX/PPTX/XLSX into editable XML.
- `pack_ooxml`: repack an edited OOXML directory.
- `strict_validate_ooxml`: run schema-level DOCX/PPTX validation and redline checks.
- `pptx_thumbnail`: render a PPTX thumbnail grid for visual QA.
- `xlsx_recalc`: recalculate formulas through LibreOffice and report spreadsheet errors.
- `pdf_to_images`: render PDF pages to PNG for visual/OCR workflows.

If you need detailed manual procedures, read:

- `references/pptx-editing.md` for template and OOXML PPTX editing.
- `references/pptxgenjs.md` for scratch PPTX generation patterns.
- `references/pdf-advanced.md` for advanced PDF operations.
- `references/pdf-forms.md` for fillable and non-fillable PDF form workflows.
- `references/commercial-pptx.md` for executive deck structure and visual QA heuristics.

## Commercial PPT Standard

Before building slides, define the audience, decision goal, brand palette, typography, footer/header system, page number treatment, and slide taxonomy. A business deck should usually include a cover, section divider, evidence card, matrix, timeline, process path, comparison, recommendation, and action plan.

Every slide needs one message, one primary structure, and enough visual evidence to be scannable. Avoid default blue decks, generic bullet pages, random spacing, and text-only slides. Use image/media intentionally, preserve aspect ratio, and validate media relationships after insertion.

## Quality Gates

Never call an Office artifact finished unless:

- the output file exists in the requested native format
- expected text is present
- page, slide, or sheet counts match intent
- images and media relationships are coherent
- generated or edited OOXML is readable
- comments, revisions, charts, timing, and formulas are validated when used
- LibreOffice/WPS/Office open check is executed or explicitly reported as unavailable/skipped
- **aesthetic check**: verify against the Aesthetic Red Lines — any violation means do not ship
- the audit trail records session, agent, tool, args, output path, hash, and timestamp where supported
