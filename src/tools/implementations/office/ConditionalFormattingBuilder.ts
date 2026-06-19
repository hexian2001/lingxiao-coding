/**
 * ConditionalFormattingBuilder.ts
 * 
 * Excel Conditional Formatting implementation for XLSX files.
 * Supports Data Bars, Color Scales, Icon Sets, and formula-based rules.
 * 
 * Based on OOXML SpreadsheetML specification.
 */

export type CfvoType = 'min' | 'max' | 'num' | 'percent' | 'percentile' | 'formula';

export interface Cfvo {
  type: CfvoType;
  val?: string | number;
}

export interface DataBarRule {
  type: 'dataBar';
  minValue: Cfvo;
  maxValue: Cfvo;
  color: string; // RGB hex format: "FF638EC6"
  showValue?: boolean; // Whether to show cell value alongside bar
}

export interface ColorScaleRule {
  type: 'colorScale';
  minValue: Cfvo;
  minColor: string;
  midValue?: Cfvo;
  midColor?: string;
  maxValue: Cfvo;
  maxColor: string;
}

export type IconSetType = 
  | '3Arrows' 
  | '3ArrowsGray' 
  | '3Flags' 
  | '3TrafficLights1' 
  | '3TrafficLights2' 
  | '3Signs' 
  | '3Symbols' 
  | '3Symbols2'
  | '4Arrows' 
  | '4ArrowsGray' 
  | '4RedToBlack' 
  | '4Rating' 
  | '4TrafficLights'
  | '5Arrows' 
  | '5ArrowsGray' 
  | '5Rating' 
  | '5Quarters';

export interface IconSetRule {
  type: 'iconSet';
  iconSet: IconSetType;
  values: Cfvo[]; // 2-5 thresholds depending on icon set
  reverse?: boolean; // Reverse icon order
  showValue?: boolean; // Show cell value alongside icon
}

export interface CellIsRule {
  type: 'cellIs';
  operator: 'lessThan' | 'lessThanOrEqual' | 'equal' | 'notEqual' | 'greaterThanOrEqual' | 'greaterThan' | 'between' | 'notBetween';
  formula: string | string[]; // Single value or array for 'between'
  dxfId: number; // Style reference
}

export interface ExpressionRule {
  type: 'expression';
  formula: string; // Excel formula expression
  dxfId: number; // Style reference
}

export interface Top10Rule {
  type: 'top10';
  rank: number; // Number of top/bottom items
  bottom?: boolean; // If true, bottom N instead of top N
  percent?: boolean; // If true, top/bottom N percent
  dxfId: number;
}

export type ConditionalFormattingRule = 
  | DataBarRule 
  | ColorScaleRule 
  | IconSetRule 
  | CellIsRule 
  | ExpressionRule
  | Top10Rule;

export interface ConditionalFormatting {
  sqref: string; // Cell range like "A1:A10"
  rules: ConditionalFormattingRule[];
}

/**
 * Generate CFVO (Conditional Format Value Object) XML
 */
function cfvoXml(cfvo: Cfvo): string {
  const valAttr = cfvo.val !== undefined ? ` val="${cfvo.val}"` : '';
  return `<cfvo type="${cfvo.type}"${valAttr}/>`;
}

/**
 * Generate color XML element
 */
function colorXml(rgb: string): string {
  // Ensure 8-character RGB format (AARRGGBB)
  const normalized = rgb.length === 6 ? `FF${rgb}` : rgb;
  return `<color rgb="${normalized}"/>`;
}

/**
 * Generate Data Bar conditional formatting rule XML
 */
export function dataBarRuleXml(rule: DataBarRule, priority: number): string {
  const showValueAttr = rule.showValue === false ? ' showValue="0"' : '';
  
  return `<cfRule type="dataBar" priority="${priority}">
  <dataBar${showValueAttr}>
    ${cfvoXml(rule.minValue)}
    ${cfvoXml(rule.maxValue)}
    ${colorXml(rule.color)}
  </dataBar>
</cfRule>`;
}

/**
 * Generate Color Scale conditional formatting rule XML
 */
export function colorScaleRuleXml(rule: ColorScaleRule, priority: number): string {
  const isThreeColor = rule.midValue && rule.midColor;
  
  if (isThreeColor) {
    return `<cfRule type="colorScale" priority="${priority}">
  <colorScale>
    ${cfvoXml(rule.minValue)}
    ${cfvoXml(rule.midValue!)}
    ${cfvoXml(rule.maxValue)}
    ${colorXml(rule.minColor)}
    ${colorXml(rule.midColor!)}
    ${colorXml(rule.maxColor)}
  </colorScale>
</cfRule>`;
  } else {
    return `<cfRule type="colorScale" priority="${priority}">
  <colorScale>
    ${cfvoXml(rule.minValue)}
    ${cfvoXml(rule.maxValue)}
    ${colorXml(rule.minColor)}
    ${colorXml(rule.maxColor)}
  </colorScale>
</cfRule>`;
  }
}

/**
 * Generate Icon Set conditional formatting rule XML
 */
export function iconSetRuleXml(rule: IconSetRule, priority: number): string {
  const reverseAttr = rule.reverse ? ' reverse="1"' : '';
  const showValueAttr = rule.showValue === false ? ' showValue="0"' : '';
  
  const cfvos = rule.values.map(cfvoXml).join('\n    ');
  
  return `<cfRule type="iconSet" priority="${priority}">
  <iconSet iconSet="${rule.iconSet}"${reverseAttr}${showValueAttr}>
    ${cfvos}
  </iconSet>
</cfRule>`;
}

/**
 * Generate Cell Is conditional formatting rule XML
 */
export function cellIsRuleXml(rule: CellIsRule, priority: number): string {
  const formulas = Array.isArray(rule.formula) ? rule.formula : [rule.formula];
  const formulaXml = formulas.map(f => `<formula>${f}</formula>`).join('\n    ');
  
  return `<cfRule type="cellIs" dxfId="${rule.dxfId}" priority="${priority}" operator="${rule.operator}">
  ${formulaXml}
</cfRule>`;
}

/**
 * Generate Expression conditional formatting rule XML
 */
export function expressionRuleXml(rule: ExpressionRule, priority: number): string {
  return `<cfRule type="expression" dxfId="${rule.dxfId}" priority="${priority}">
  <formula>${rule.formula}</formula>
</cfRule>`;
}

/**
 * Generate Top 10 conditional formatting rule XML
 */
export function top10RuleXml(rule: Top10Rule, priority: number): string {
  const bottomAttr = rule.bottom ? ' bottom="1"' : '';
  const percentAttr = rule.percent ? ' percent="1"' : '';
  
  return `<cfRule type="top10" dxfId="${rule.dxfId}" priority="${priority}" rank="${rule.rank}"${bottomAttr}${percentAttr}/>`;
}

/**
 * Generate conditional formatting rule XML based on type
 */
export function conditionalFormattingRuleXml(rule: ConditionalFormattingRule, priority: number): string {
  switch (rule.type) {
    case 'dataBar':
      return dataBarRuleXml(rule, priority);
    case 'colorScale':
      return colorScaleRuleXml(rule, priority);
    case 'iconSet':
      return iconSetRuleXml(rule, priority);
    case 'cellIs':
      return cellIsRuleXml(rule, priority);
    case 'expression':
      return expressionRuleXml(rule, priority);
    case 'top10':
      return top10RuleXml(rule, priority);
  }
}

/**
 * Generate complete conditional formatting XML for a range
 */
export function conditionalFormattingXml(cf: ConditionalFormatting, startPriority = 1): string {
  const rulesXml = cf.rules
    .map((rule, index) => conditionalFormattingRuleXml(rule, startPriority + index))
    .join('\n  ');
  
  return `<conditionalFormatting sqref="${cf.sqref}">
  ${rulesXml}
</conditionalFormatting>`;
}

/**
 * Generate multiple conditional formatting blocks
 */
export function multipleConditionalFormattingXml(formats: ConditionalFormatting[]): string {
  let priority = 1;
  const blocks: string[] = [];
  
  for (const cf of formats) {
    blocks.push(conditionalFormattingXml(cf, priority));
    priority += cf.rules.length;
  }
  
  return blocks.join('\n');
}

/**
 * Helper: Create a data bar rule with default settings
 */
export function createDataBarRule(color: string, showValue = true): DataBarRule {
  return {
    type: 'dataBar',
    minValue: { type: 'min' },
    maxValue: { type: 'max' },
    color,
    showValue,
  };
}

/**
 * Helper: Create a two-color scale rule
 */
export function createTwoColorScale(minColor: string, maxColor: string): ColorScaleRule {
  return {
    type: 'colorScale',
    minValue: { type: 'min' },
    minColor,
    maxValue: { type: 'max' },
    maxColor,
  };
}

/**
 * Helper: Create a three-color scale rule
 */
export function createThreeColorScale(minColor: string, midColor: string, maxColor: string): ColorScaleRule {
  return {
    type: 'colorScale',
    minValue: { type: 'min' },
    minColor,
    midValue: { type: 'percentile', val: 50 },
    midColor,
    maxValue: { type: 'max' },
    maxColor,
  };
}

/**
 * Helper: Create a 3-icon set rule with percentile thresholds
 */
export function createIconSetRule(iconSet: IconSetType, reverse = false, showValue = true): IconSetRule {
  // Default thresholds for 3-icon sets
  const values: Cfvo[] = [
    { type: 'percentile', val: 0 },
    { type: 'percentile', val: 33 },
    { type: 'percentile', val: 67 },
  ];
  
  return {
    type: 'iconSet',
    iconSet,
    values,
    reverse,
    showValue,
  };
}

/**
 * Helper: Create a 5-icon set rule with percentile thresholds
 */
export function createFiveIconSetRule(iconSet: IconSetType, reverse = false, showValue = true): IconSetRule {
  const values: Cfvo[] = [
    { type: 'percentile', val: 0 },
    { type: 'percentile', val: 20 },
    { type: 'percentile', val: 40 },
    { type: 'percentile', val: 60 },
    { type: 'percentile', val: 80 },
  ];
  
  return {
    type: 'iconSet',
    iconSet,
    values,
    reverse,
    showValue,
  };
}

/**
 * Predefined color schemes
 */
export const ColorSchemes = {
  // Red-Yellow-Green (traffic light)
  RedYellowGreen: {
    min: 'F8696B',
    mid: 'FFEB84',
    max: '63BE7B',
  },
  // Blue-White-Red (heat map)
  BlueWhiteRed: {
    min: '5A8AC6',
    mid: 'FFFFFF',
    max: 'F8696B',
  },
  // Green-White-Red
  GreenWhiteRed: {
    min: '63BE7B',
    mid: 'FFFFFF',
    max: 'F8696B',
  },
  // Blue gradient
  BlueGradient: {
    min: 'FFFFFF',
    max: '5A8AC6',
  },
  // Green gradient
  GreenGradient: {
    min: 'FFFFFF',
    max: '63BE7B',
  },
  // Red gradient
  RedGradient: {
    min: 'FFFFFF',
    max: 'F8696B',
  },
};
