/**
 * Clipboard utility — copy text to system clipboard from TUI.
 *
 * Strategy:
 * 1. OSC 52 escape sequence (works in iTerm2, kitty, WezTerm, Windows Terminal, etc.)
 * 2. Platform clipboard tool (pbcopy / xclip / xsel / clip.exe)
 */

import { execSync } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Copy text to system clipboard via OSC 52 escape sequence.
 * Most modern terminals support this natively.
 */
function copyViaOSC52(text: string): void {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  // OSC 52: \x1b]52;c;<base64>\x07
  // Use \x1b\\ (ST) as terminator for broader terminal support.
  process.stdout.write(`\x1b]52;c;${b64}\x1b\\`);
}

/**
 * Try to copy via platform clipboard tool when OSC 52 is unavailable.
 * Returns true if successful.
 */
function copyViaTool(text: string): boolean {
  const os = platform();
  let cmd: string;

  if (os === 'darwin') {
    cmd = 'pbcopy';
  } else if (os === 'win32') {
    cmd = 'clip.exe';
  } else {
    // Linux / WSL — try xclip first, then xsel, then clip.exe (for WSL)
    try {
      execSync('which xclip', { stdio: 'ignore' });
      cmd = 'xclip -selection clipboard';
    } catch {/* swallowed: unhandled error */
      try {
        execSync('which xsel', { stdio: 'ignore' });
        cmd = 'xsel --clipboard --input';
      } catch {/* swallowed: unhandled error */
        try {
          // WSL has clip.exe available
          execSync('which clip.exe', { stdio: 'ignore' });
          cmd = 'clip.exe';
        } catch {/* expected: operation may fail */
          return false;
        }
      }
    }
  }

  try {
    execSync(cmd, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    return true;
  } catch {/* expected: operation may fail */
    return false;
  }
}

/**
 * Copy text to system clipboard.
 * Uses OSC 52 (terminal-native) + platform tool as backup.
 */
export function copyToClipboard(text: string): void {
  // Always emit OSC 52 — it's zero-cost and works when supported
  copyViaOSC52(text);
  // Also try platform tool as backup (some terminals don't support OSC 52)
  copyViaTool(text);
}
