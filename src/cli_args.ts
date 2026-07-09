const ROOT_HELP_OR_VERSION = new Set(['-h', '--help', '-V', '--version']);

/**
 * Lingxiao's public entrypoint is `lingxiao`; `start` is an internal/default
 * command. Normalize root-level startup flags before Commander rejects them.
 */
export function normalizeDefaultStartArgs(argv: string[]): string[] {
  const safeArgv = Array.isArray(argv) && argv.length > 0
    ? argv
    : [process.execPath, 'cli.js'];
  let [node, script, ...args] = safeArgv;
  node = typeof node === 'string' && node ? node : process.execPath;
  script = typeof script === 'string' && script ? script : 'cli.js';

  // Under Electron ELECTRON_RUN_AS_NODE mode (desktop production), Electron may
  // insert its own bootstrap/main.js path at argv[1], pushing cli.js to argv[2+].
  // This makes Commander treat the script path as a command name ("unknown command").
  // Detect and strip the spurious entry so argv = [node, cli.js, ...realArgs].
  if (!script.endsWith('cli.js')) {
    const cliIdx = safeArgv.findIndex((a, i) => i > 0 && typeof a === 'string' && a.endsWith('cli.js'));
    if (cliIdx > 1) {
      node = safeArgv[0]!;
      script = safeArgv[cliIdx]!;
      args = safeArgv.slice(cliIdx + 1);
    }
  }

  if (args.length === 0) {
    return [node, script, 'start'];
  }

  const first = args[0];
  if (ROOT_HELP_OR_VERSION.has(first)) {
    return [node, script, ...args];
  }

  if (first.startsWith('-')) {
    return [node, script, 'start', ...args];
  }

  return [node, script, ...args];
}
