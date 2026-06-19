export interface SkillSelectionPolicy {
  disabledSkillNames: string[];
  digestGuidance: string[];
}

export const SKILL_SELECTION_POLICY: SkillSelectionPolicy = {
  disabledSkillNames: [],
  digestGuidance: [
    '按任务目标主动选择 skill_names；用户显式写 $skill 时按指定 skill 优先。',
    '当用户要演示、幻灯片、deck、presentation 但没有指定交付格式时，先询问偏好：HTML 演示还是原生 PPTX 文件；明确要 PPT/PPTX 时使用 generate_pptx，后续改稿使用 edit_pptx。',
    '技术演示或代码课程可推荐 Slidev；PPT 需求按用户交付格式偏好选择 HTML 演示或原生 PPTX。',
    '文档、报告、方案、材料优先询问 DOCX/PDF/HTML 交付格式；明确要 Word/DOCX 时使用 generate_docx，后续改稿使用 edit_docx。',
    '表格数据走 XLSX/edit_xlsx；PDF 解析必须标注是否有文本层，纯图/扫描件转 OCR 路径；素材需求走 office_ops(action="assets")。',
  ],
};

export function isSkillDisabledByPolicy(name: string): boolean {
  return SKILL_SELECTION_POLICY.disabledSkillNames.includes(name);
}
