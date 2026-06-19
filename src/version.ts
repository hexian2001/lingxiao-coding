import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const pkgDir = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(pkgDir, '..', 'package.json'), 'utf-8')) as {
  name?: string;
  version: string;
};

export const PACKAGE_NAME: string = pkg.name || 'lingxiao_cli';
export const VERSION: string = pkg.version;
export const PRODUCT_NAME = 'lingxiao-cli';
export const PRODUCT_DISPLAY_NAME = 'LingXiaoCLI';
export const PRODUCT_USER_AGENT_COMMENT = 'AI coding agent; LLM requests';

const PRINTABLE_ASCII_RE = /^[\x20-\x7E]*$/;
const LINGXIAO_DEFAULT_USER_AGENT_RE = /^LingXiaoCLI\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)? \(AI coding agent; LLM requests\)$/;

export function buildLingxiaoUserAgent(version = VERSION): string {
  return `${PRODUCT_DISPLAY_NAME}/${version} (${PRODUCT_USER_AGENT_COMMENT})`;
}

export function buildLingxiaoComponentUserAgent(component: string, version = VERSION): string {
  const label = component.trim();
  return label ? `${PRODUCT_NAME}/${version} (${label})` : `${PRODUCT_NAME}/${version}`;
}

export const DEFAULT_LINGXIAO_USER_AGENT = buildLingxiaoUserAgent();

export function isValidUserAgent(value: string): boolean {
  return value.length <= 512 && PRINTABLE_ASCII_RE.test(value);
}

export function isLingxiaoDefaultUserAgent(value: unknown): boolean {
  return typeof value === 'string' && LINGXIAO_DEFAULT_USER_AGENT_RE.test(value.trim());
}

export function normalizeLingxiaoUserAgent(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || isLingxiaoDefaultUserAgent(raw) || !isValidUserAgent(raw)) {
    return DEFAULT_LINGXIAO_USER_AGENT;
  }
  return raw;
}
