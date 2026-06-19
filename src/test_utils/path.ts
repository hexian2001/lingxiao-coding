export function slashPath(value: unknown): string {
  return String(value).replace(/\\/g, '/');
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
