export type OfficePreviewKind = 'pptx' | 'docx';

export type OfficePreviewUnit = 'in';

export interface OfficePreviewBBox {
  x: number;
  y: number;
  w: number;
  h: number;
  unit: OfficePreviewUnit;
}

export interface OfficePreviewSize {
  width: number;
  height: number;
  unit: OfficePreviewUnit;
}

export interface OfficePreviewTheme {
  name?: string;
  headFontFace?: string;
  bodyFontFace?: string;
  majorFontFace?: string;
  minorFontFace?: string;
  defaultFontFace?: string;
}

export interface OfficePreviewStyle {
  fontFace?: string;
  fontSizePt?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  fillColor?: string;
  lineColor?: string;
  paragraphStyle?: string;
  level?: number;
  align?: string;
}

export interface OfficePreviewAsset {
  id: string;
  relationshipId?: string;
  kind: 'image' | 'media' | 'ole' | 'external' | 'unknown';
  path?: string;
  target?: string;
  contentType?: string;
  extension?: string;
}

export interface OfficePreviewTableCell {
  id: string;
  text: string;
  rowSpan?: number;
  colSpan?: number;
  style?: OfficePreviewStyle;
}

export interface OfficePreviewTableRow {
  id: string;
  cells: OfficePreviewTableCell[];
}

export interface OfficePreviewElement {
  id: string;
  sourceId?: string;
  kind: 'text' | 'shape' | 'image' | 'table' | 'paragraph' | 'drawing' | 'pageBreak' | 'unknown';
  name?: string;
  text?: string;
  bbox?: OfficePreviewBBox;
  style?: OfficePreviewStyle;
  relationshipId?: string;
  assetId?: string;
  rows?: OfficePreviewTableRow[];
  children?: OfficePreviewElement[];
  metadata?: Record<string, unknown>;
}

export interface OfficePreviewPage {
  id: string;
  index: number;
  name?: string;
  entryPath?: string;
  size: OfficePreviewSize;
  elements: OfficePreviewElement[];
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface OfficePreviewModel {
  schema: 'lingxiao.office.preview.v1';
  kind: OfficePreviewKind;
  renderer: 'office-preview-structure';
  pageSize: OfficePreviewSize;
  theme: OfficePreviewTheme;
  pages: OfficePreviewPage[];
  assets: OfficePreviewAsset[];
  warnings: string[];
  stats: {
    pageCount: number;
    elementCount: number;
    textElementCount: number;
    imageCount: number;
    tableCount: number;
  };
}

