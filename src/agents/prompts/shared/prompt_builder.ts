export function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

export function numbered(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

export function section(title: string, body: string | string[], level = 2): string {
  const content = Array.isArray(body) ? body.join('\n') : body;
  return `${'#'.repeat(level)} ${title}\n${content}`.trim();
}

export function joinBlocks(blocks: Array<string | null | undefined>): string {
  return blocks.filter((block): block is string => typeof block === 'string' && block.trim().length > 0).join('\n\n');
}

export function paragraphLines(lines: Array<string | null | undefined>): string {
  return lines.filter((line): line is string => typeof line === 'string' && line.trim().length > 0).join('\n');
}
