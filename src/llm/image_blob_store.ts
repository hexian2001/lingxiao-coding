import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { ChatMessage, ImageBlobRefContentPart, MessageContent, MessageContentPart } from './types.js';

const DATA_IMAGE_RE = /^data:([^;]+);base64,(.+)$/s;
const INLINE_DATA_IMAGE_RE = /data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]{1000,})/g;
const DEFAULT_RETAIN_IMAGE_ROUNDS = 2;

export function normalizeImageRetainRounds(
  retainRounds: unknown,
  fallback = DEFAULT_RETAIN_IMAGE_ROUNDS,
): number {
  const value = Number(retainRounds);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function blobRoot(): string {
  return join(process.cwd(), '.lingxiao', 'blobs', 'images');
}

function extensionForMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  const suffix = mime.split('/')[1]?.replace(/[^a-zA-Z0-9]+/g, '') || 'bin';
  return suffix || 'bin';
}

function placeholder(ref: ImageBlobRefContentPart): string {
  const kb = Math.max(1, Math.round(ref.size / 1024));
  return `[Image from ${ref.source || 'tool result'} (${ref.mime}, ${kb}KB) - stored as blob:${ref.blob_id.slice(0, 12)}]`;
}

export async function storeImageDataUri(
  dataUri: string,
  source?: string,
): Promise<ImageBlobRefContentPart | null> {
  const match = dataUri.match(DATA_IMAGE_RE);
  if (!match) return null;

  const mime = match[1];
  const base64 = match[2];
  const buffer = Buffer.from(base64, 'base64');
  const blobId = createHash('sha256').update(buffer).digest('hex');
  const dir = blobRoot();
  const blobPath = join(dir, `${blobId}.${extensionForMime(mime)}`);

  if (!existsSync(blobPath)) {
    await mkdir(dir, { recursive: true });
    await writeFile(blobPath, buffer);
  }

  return {
    type: 'image_blob_ref',
    blob_id: blobId,
    mime,
    size: buffer.length,
    blob_path: blobPath,
    source,
  };
}

export async function rehydrateImageBlobRef(ref: ImageBlobRefContentPart): Promise<string | null> {
  try {
    const buffer = await readFile(ref.blob_path);
    return `data:${ref.mime};base64,${buffer.toString('base64')}`;
  } catch {/* expected: operation may fail gracefully */
    return null;
  }
}

export function isImageBlobRef(part: unknown): part is ImageBlobRefContentPart {
  return Boolean(
    part &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'image_blob_ref' &&
    typeof (part as { blob_id?: unknown }).blob_id === 'string'
  );
}

export async function externalizeImageDataInContent(
  content: MessageContent,
  source?: string,
): Promise<MessageContent> {
  if (Array.isArray(content)) {
    let changed = false;
    const next: MessageContentPart[] = [];
    for (const part of content) {
      if (part.type === 'image_url' && part.image_url.url.startsWith('data:')) {
        const ref = await storeImageDataUri(part.image_url.url, source);
        if (ref) {
          next.push(ref);
          changed = true;
          continue;
        }
      }
      next.push(part);
    }
    return changed ? next : content;
  }

  if (typeof content === 'string' && content.includes('data:image/')) {
    let result = content;
    const matches = Array.from(content.matchAll(INLINE_DATA_IMAGE_RE));
    for (const match of matches) {
      const ref = await storeImageDataUri(match[0], source);
      if (ref) {
        result = result.replace(match[0], JSON.stringify(ref));
      }
    }
    return result;
  }

  return content;
}

export async function rehydrateRecentImageBlobRefs(
  messages: ChatMessage[],
  retainRounds = DEFAULT_RETAIN_IMAGE_ROUNDS,
): Promise<ChatMessage[]> {
  const normalizedRetainRounds = normalizeImageRetainRounds(retainRounds);
  let userRounds = 0;
  let cutoffIndex = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userRounds++;
      if (userRounds >= normalizedRetainRounds) {
        cutoffIndex = i;
        break;
      }
    }
  }

  const result: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!Array.isArray(message.content) || !message.content.some(isImageBlobRef)) {
      result.push(message);
      continue;
    }

    const nextParts: MessageContentPart[] = [];
    for (const part of message.content) {
      if (!isImageBlobRef(part)) {
        nextParts.push(part);
        continue;
      }

      if (i >= cutoffIndex) {
        const dataUri = await rehydrateImageBlobRef(part);
        if (dataUri) {
          nextParts.push({ type: 'image_url', image_url: { url: dataUri, detail: 'auto' } });
          continue;
        }
      }

      nextParts.push({ type: 'text', text: placeholder(part) });
    }

    result.push({ ...message, content: nextParts });
  }

  return result;
}
