/**
 * Clipboard utility — copy text to system clipboard from TUI.
 *
 * Strategy:
 * 1. OSC 52 escape sequence (works in iTerm2, kitty, WezTerm, Windows Terminal, etc.)
 * 2. Platform clipboard tool (pbcopy / xclip / xsel / clip.exe)
 */

import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';

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

/**
 * Read an image from the system clipboard and save it to a temp file.
 * Supports three platforms:
 *   - macOS: osascript + AppleScript (clipboard as «class PNGf»)
 *   - Linux X11: xclip -selection clipboard -t image/png -o
 *   - Linux Wayland: wl-paste --type image/png
 *   - Windows: PowerShell Get-Clipboard -Format Image
 * Returns the temp file path, or null if no image is in the clipboard.
 */
export function readClipboardImage(): string | null {
  const os = platform();
  const tmpPath = join(tmpdir(), `lingxiao-clipboard-${Date.now()}.png`);

  if (os === 'darwin') {
    return readClipboardImageMacos(tmpPath);
  }
  if (os === 'linux') {
    return readClipboardImageLinux(tmpPath);
  }
  if (os === 'win32') {
    return readClipboardImageWindows(tmpPath);
  }
  return null;
}

/** macOS: use osascript to read clipboard PNG data */
function readClipboardImageMacos(tmpPath: string): string | null {
  // AppleScript: check if clipboard has PNG image data, write to temp file
  const script = `
set tmpPath to "${tmpPath}"
try
    set imgData to the clipboard as «class PNGf»
    set fp to open for access tmpPath with write permission
    write imgData to fp
    close access fp
    return tmpPath
on error
    return ""
end try
`.trim();

  try {
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    if (!result || !existsSync(tmpPath)) return null;
    if (statSync(tmpPath).size === 0) return null;
    return tmpPath;
  } catch {
    return null;
  }
}

/** Linux: try xclip (X11) → wl-paste (Wayland) → xsel (X11 fallback) */
function readClipboardImageLinux(tmpPath: string): string | null {
  // Strategy 1: xclip (X11)
  try {
    execSync('which xclip', { stdio: 'ignore', timeout: 2000 });
    execSync(`xclip -selection clipboard -t image/png -o > "${tmpPath}"`, {
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 5000,
    });
    if (existsSync(tmpPath) && statSync(tmpPath).size > 0) return tmpPath;
  } catch { /* xclip not available or no image in clipboard */ }

  // Strategy 2: wl-paste (Wayland)
  try {
    execSync('which wl-paste', { stdio: 'ignore', timeout: 2000 });
    execSync(`wl-paste --type image/png > "${tmpPath}"`, {
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 5000,
    });
    if (existsSync(tmpPath) && statSync(tmpPath).size > 0) return tmpPath;
  } catch { /* wl-paste not available or no image in clipboard */ }

  // Strategy 3: xsel (X11, fallback — less reliable for images)
  try {
    execSync('which xsel', { stdio: 'ignore', timeout: 2000 });
    execSync(`xsel --clipboard --input > "${tmpPath}"`, {
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 5000,
    });
    if (existsSync(tmpPath) && statSync(tmpPath).size > 0) return tmpPath;
  } catch { /* xsel not available or no image in clipboard */ }

  return null;
}

/** Windows: use PowerShell to save clipboard image to temp file */
function readClipboardImageWindows(tmpPath: string): string | null {
  // PowerShell: check if clipboard contains an image, save as PNG
  const psScript = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($img -ne $null) {',
    `  $img.Save("${tmpPath.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)`,
    '  Write-Output "ok"',
    '} else {',
    '  Write-Output "no"',
    '}',
  ].join(';');

  try {
    const result = execSync(`powershell -NoProfile -Command "${psScript}"`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 8000,
    }).trim();
    if (result !== 'ok' || !existsSync(tmpPath)) return null;
    if (statSync(tmpPath).size === 0) return null;
    return tmpPath;
  } catch {
    return null;
  }
}
