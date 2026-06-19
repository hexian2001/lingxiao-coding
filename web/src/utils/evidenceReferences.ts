import type { Message } from '../stores/sessionStoreTypes';

export type EvidenceReferenceKind = 'file' | 'url' | 'artifact' | 'screenshot';

export interface EvidenceReference {
  id: string;
  kind: EvidenceReferenceKind;
  label: string;
  path?: string;
  url?: string;
  line?: number;
  column?: number;
  source: 'message' | 'tool';
  tool?: string;
  messageId?: string;
}

const FILE_RE = /(?:^|[\s([{"'`])((?:\.{1,2}\/|\/)?(?:[\w@.+ -]+\/)*[\w@.+ -]+\.(?:tsx?|jsx?|mjs|cjs|py|md|mdx|json|ya?ml|toml|css|scss|html|sh|sql|vue|svelte|png|jpe?g|webp|gif|svg|pdf|docx|pptx|xlsx))(?:\:(\d+))?(?:\:(\d+))?(?=$|[\s:),\]}"'`])/gi;
const URL_RE = /\bhttps?:\/\/[^\s<>)"']+/gi;

function pushUnique(refs: EvidenceReference[], ref: EvidenceReference): void {
  const key = `${ref.kind}:${ref.path || ref.url || ref.label}:${ref.line || ''}:${ref.column || ''}`;
  if (refs.some((item) => item.id === key)) return;
  refs.push({ ...ref, id: key });
}

function basename(value: string): string {
  return value.split('/').filter(Boolean).pop() || value;
}

export function extractEvidenceReferencesFromText(
  text: string,
  meta: Pick<EvidenceReference, 'source' | 'tool' | 'messageId'>,
): EvidenceReference[] {
  const refs: EvidenceReference[] = [];
  for (const match of text.matchAll(FILE_RE)) {
    const path = match[1];
    const line = match[2] ? Number(match[2]) : undefined;
    const column = match[3] ? Number(match[3]) : undefined;
    const lower = path.toLowerCase();
    const kind: EvidenceReferenceKind = /\.(png|jpe?g|webp|gif|svg|pdf|docx|pptx|xlsx)$/.test(lower)
      ? 'artifact'
      : 'file';
    pushUnique(refs, {
      id: '',
      kind,
      label: line ? `${basename(path)}:${line}` : basename(path),
      path,
      line,
      column,
      ...meta,
    });
  }
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[),.;]+$/, '');
    pushUnique(refs, {
      id: '',
      kind: 'url',
      label: url.replace(/^https?:\/\//, '').slice(0, 80),
      url,
      ...meta,
    });
  }
  return refs;
}

function extractFromUnknown(value: unknown, meta: Pick<EvidenceReference, 'source' | 'tool' | 'messageId'>): EvidenceReference[] {
  const refs: EvidenceReference[] = [];
  if (typeof value === 'string') {
    return extractEvidenceReferencesFromText(value, meta);
  }
  if (!value || typeof value !== 'object') return refs;
  const record = value as Record<string, unknown>;
  const directPath = record.path || record.file_path || record.screenshot_path;
  const directUrl = record.url || record.preview_url;
  if (typeof directPath === 'string') {
    const lower = directPath.toLowerCase();
    const kind: EvidenceReferenceKind = record.screenshot_path ? 'screenshot' : /\.(png|jpe?g|webp|gif|svg|pdf|docx|pptx|xlsx)$/.test(lower) ? 'artifact' : 'file';
    pushUnique(refs, {
      id: '',
      kind,
      label: basename(directPath),
      path: directPath,
      ...meta,
    });
  }
  if (typeof directUrl === 'string') {
    pushUnique(refs, {
      id: '',
      kind: 'url',
      label: directUrl.replace(/^https?:\/\//, '').slice(0, 80),
      url: directUrl,
      ...meta,
    });
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'string') {
      for (const ref of extractEvidenceReferencesFromText(value, meta)) pushUnique(refs, ref);
    } else if (Array.isArray(value)) {
      for (const item of value.slice(0, 50)) {
        for (const ref of extractFromUnknown(item, meta)) pushUnique(refs, ref);
      }
    } else if (value && typeof value === 'object') {
      for (const ref of extractFromUnknown(value, meta)) pushUnique(refs, ref);
    }
  }
  return refs;
}

export function collectEvidenceReferences(messages: Message[], limit = 80): EvidenceReference[] {
  const refs: EvidenceReference[] = [];
  for (const message of messages) {
    for (const ref of extractEvidenceReferencesFromText(message.content || '', {
      source: 'message',
      messageId: message.id,
    })) pushUnique(refs, ref);
    for (const toolCall of message.toolCalls || []) {
      for (const ref of extractFromUnknown(toolCall.input, {
        source: 'tool',
        tool: toolCall.tool,
        messageId: message.id,
      })) pushUnique(refs, ref);
      for (const ref of extractFromUnknown(toolCall.result, {
        source: 'tool',
        tool: toolCall.tool,
        messageId: message.id,
      })) pushUnique(refs, ref);
    }
  }
  return refs.slice(-limit).reverse();
}
