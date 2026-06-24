/**
 * OfficeClient — v1.0.5 剑阁大改：直接 HTTP API 生成办公文件
 */

import { apiHeaders } from './headers';

export interface OfficeFormatInfo {
  format: 'pdf' | 'pptx' | 'docx' | 'xlsx';
  name: string;
  icon: string;
  description: string;
  extensions: string[];
}

export interface OfficeTemplate {
  id: string;
  name: string;
  group: string;
}

export interface OfficeGenerateResult {
  success: boolean;
  format: string;
  path?: string;
  downloadUrl?: string | null;
  [key: string]: unknown;
}

async function readJson<T>(res: Response): Promise<T> {
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(json?.error || `HTTP ${res.status}`);
  }
  return json?.data as T;
}

export const officeClient = {
  async getFormats(): Promise<OfficeFormatInfo[]> {
    const res = await fetch('/api/v1/office/formats', { headers: apiHeaders() });
    return readJson<OfficeFormatInfo[]>(res);
  },

  async getTemplates(): Promise<OfficeTemplate[]> {
    const res = await fetch('/api/v1/office/templates', { headers: apiHeaders() });
    return readJson<OfficeTemplate[]>(res);
  },

  async generate(
    format: 'pdf' | 'pptx' | 'docx' | 'xlsx',
    params: Record<string, unknown>,
    options?: { outputPath?: string; createDownloadLink?: boolean },
  ): Promise<OfficeGenerateResult> {
    const res = await fetch('/api/v1/office/generate', {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        format,
        params,
        outputPath: options?.outputPath,
        createDownloadLink: options?.createDownloadLink ?? true,
      }),
    });
    return readJson<OfficeGenerateResult>(res);
  },
};
