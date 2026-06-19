const ROOT_HELP_OR_VERSION = new Set(['-h', '--help', '-V', '--version']);

/**
 * Lingxiao's public entrypoint is `lingxiao`; `start` is an internal/default
 * command. Normalize root-level startup flags before Commander rejects them.
 */
export function normalizeDefaultStartArgs(argv: string[]): string[] {
  const [node, script, ...args] = argv;
  if (args.length === 0) {
    return [node, script, 'start'];
  }

  const first = args[0];
  if (ROOT_HELP_OR_VERSION.has(first)) {
    return argv;
  }

  if (first.startsWith('-')) {
    return [node, script, 'start', ...args];
  }

  return argv;
}
