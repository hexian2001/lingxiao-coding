import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export interface OfficeRuntimePaths {
  root: string;
  scriptsRoot: string;
  officeScripts: string;
  docxScripts: string;
  pptxScripts: string;
  xlsxScripts: string;
  pdfScripts: string;
  references: string;
  exists: boolean;
}

export function resolveOfficeRuntimePaths(): OfficeRuntimePaths {
  const root = process.env.LINGXIAO_OFFICE_RUNTIME_DIR
    ? resolve(process.env.LINGXIAO_OFFICE_RUNTIME_DIR)
    : resolve(MODULE_DIR, '../../../../skills/bundled/office-suite');
  const scriptsRoot = resolve(root, 'scripts');
  return {
    root,
    scriptsRoot,
    officeScripts: resolve(scriptsRoot, 'office'),
    docxScripts: resolve(scriptsRoot, 'docx'),
    pptxScripts: resolve(scriptsRoot, 'pptx'),
    xlsxScripts: resolve(scriptsRoot, 'xlsx'),
    pdfScripts: resolve(scriptsRoot, 'pdf'),
    references: resolve(root, 'references'),
    exists: existsSync(root) && existsSync(scriptsRoot),
  };
}

