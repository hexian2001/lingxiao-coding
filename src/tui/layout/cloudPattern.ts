const CLOUD_BAND = [
  '  ╭────╮      ╭──╮     ╭────╮   ',
  '╰──╮  ╰──────╯  ╰──╮  ╰──╮  ╰─',
] as const;
const CLOUD_RIBBON = '╭───╮    ╭──╮   ╭────╮    ╭──╮   ';

export function renderCloudPattern(width: number, offset = 0): string {
  const target = Math.max(0, Math.floor(width));
  if (target === 0) return '';
  let out = '';
  const shift = Math.abs(Math.floor(offset)) % CLOUD_RIBBON.length;
  const source = CLOUD_RIBBON.slice(shift) + CLOUD_RIBBON.slice(0, shift);
  while (out.length < target) {
    out += source;
  }
  return out.slice(0, target);
}

export function renderCloudBand(width: number, offset = 0): readonly [string, string] {
  const target = Math.max(0, Math.floor(width));
  if (target === 0) return ['', ''];
  const shift = Math.abs(Math.floor(offset)) % CLOUD_BAND[0].length;
  const renderLine = (line: string): string => {
    const source = line.slice(shift) + line.slice(0, shift);
    let out = '';
    while (out.length < target) out += source;
    return out.slice(0, target);
  };
  return [renderLine(CLOUD_BAND[0]), renderLine(CLOUD_BAND[1])];
}

export function renderCloudDivider(width: number): string {
  const target = Math.max(0, Math.floor(width));
  if (target === 0) return '';
  if (target <= 2) return '─'.repeat(target);
  const middle = renderCloudPattern(target - 2, 2);
  return `─${middle}─`;
}
