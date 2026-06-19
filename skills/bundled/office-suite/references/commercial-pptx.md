# Commercial PPTX Reference

Use this when the user asks for a polished business deck from zero or asks to match a strong commercial deck.

## Deck Planning

Plan the deck before drawing slides:

- audience: decision maker, technical reviewer, sales prospect, board, internal team
- decision goal: approval, education, risk framing, product narrative, compliance evidence
- narrative spine: context, tension, evidence, options, recommendation, next action
- brand system: header, footer, page number, section label, confidentiality/date, typography, image treatment
- slide taxonomy: cover, section divider, evidence card, matrix, timeline, process path, system inventory, role boundary, obligation stack, recommendation, action plan

## Slide Standard

Each slide should have:

- one message headline, not a topic label
- a short subline that explains why the page matters
- one primary structure such as cards, matrix, timeline, stack, or visual path
- evidence anchors where claims need support
- consistent footer/header/page number treatment
- visual media, chart, diagram, or structured shape system on almost every page

## TUV-Style Executive Deck Pattern

The inspected reference deck used:

- 18 slides with a stable header/footer/page number system
- a clear brand header and section cue on content slides
- evidence-card layouts instead of raw bullet lists
- restrained density: rich content, but grouped into scannable regions
- media on nearly every slide
- one master/layout family to keep rhythm consistent
- notes and source-like supporting text where needed

Lingxiao should generate similar quality by first creating an archetype plan, then applying a template system, then rendering thumbnails for visual QA. Do not try to produce this quality with a single pass of generic bullets.

## Image Insertion

Images are document elements:

- use `contain` when the whole image matters
- use `cover` for hero crops or thumbnails
- avoid covering title, footer, chart labels, and evidence cards
- add captions, alt text, and attribution when appropriate
- validate media relationships after insertions

## QA Loop

Run at least one visual QA loop for client-facing PPTX:

1. Generate or edit the deck.
2. Render thumbnails with `office_ops(action="runtime", office_action="pptx_thumbnail")` or LibreOffice plus `pdftoppm`.
3. Inspect for overflow, overlaps, weak contrast, uneven gaps, stale placeholders, and broken image crops.
4. Fix affected slides.
5. Re-render and re-check changed slides.
