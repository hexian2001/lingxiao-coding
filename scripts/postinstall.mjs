/**
 * postinstall.mjs — Run after `npm install`
 *
 * 1. Sync bundled skills → ~/.lingxiao/skills/
 * 2. Browser install is opt-in: set LINGXIAO_INSTALL_BROWSER=1 to install browser binaries
 *
 * Platform support: Windows, macOS, Linux (Ubuntu/Debian/RHEL/Alpine), WSL
 *
 * - All steps are non-fatal: warnings only, never blocks installation
 * - Browser binaries are not downloaded by default to keep install fast/offline-safe
 * - If browser install is skipped, BrowserManager can download at runtime on first use
 */

import { execFileSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { platform } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const IS_WINDOWS = platform() === 'win32';
const IS_LINUX = platform() === 'linux';
const PLAYWRIGHT_CLI = join(pkgRoot, 'node_modules', 'playwright', 'cli.js');

// ─── 1. Bundled Skills Sync ──────────────────────────────────────────────────

const registryPath = resolve(pkgRoot, 'dist/core/BundledSkillRegistry.js');

if (existsSync(registryPath)) {
  try {
    const { syncBundledSkillsToGlobalDir } = await import(registryPath);
    const result = syncBundledSkillsToGlobalDir({ workspace: pkgRoot });
    const copied = result.copied?.length ?? 0;
    const skipped = result.skipped?.length ?? 0;
    const removed = result.removed?.length ?? 0;
    console.log(`[postinstall] bundled skills synced → ~/.lingxiao/skills/ (copied=${copied} skipped=${skipped} removed=${removed})`);
  } catch (e) {
    console.warn('[postinstall] skills sync failed (non-fatal):', e?.message || e);
  }
}
// else: dev environment, dist/ not built yet — skip silently

// ─── 2. Browser Installation ─────────────────────────────────────────────────

const installBrowser = process.env.LINGXIAO_INSTALL_BROWSER === '1'
  && process.env.LINGXIAO_SKIP_BROWSER !== '1'
  && process.env.LINGXIAO_SKIP_PLAYWRIGHT !== '1';

if (!installBrowser) {
  console.log('[postinstall] skipping browser install (set LINGXIAO_INSTALL_BROWSER=1 to enable)');
  process.exit(0);
}

/**
 * Ask playwright itself where it expects its chromium executable.
 * This is the canonical, version-matched, platform-aware path — no guessing.
 */
function getPlaywrightExpectedPath() {
  try {
    // Use the local playwright package bundled with lingxiao
    const result = spawnSync(
      process.execPath, // node
      ['-e', "const {chromium}=require('playwright');try{console.log(chromium.executablePath())}catch(e){process.exit(1)}"],
      { encoding: 'utf8', timeout: 10_000, cwd: pkgRoot },
    );
    const p = result.stdout?.trim();
    return p || null;
  } catch {
    return null;
  }
}

/** Returns true if playwright's expected chromium executable already exists on disk */
function hasPlaywrightChromium() {
  const p = getPlaywrightExpectedPath();
  return !!(p && existsSync(p));
}

if (hasPlaywrightChromium()) {
  console.log('[postinstall] playwright chromium already installed — skipping');
} else if (!existsSync(PLAYWRIGHT_CLI)) {
  console.warn(`[postinstall] local Playwright CLI not found: ${PLAYWRIGHT_CLI}`);
  console.warn('[postinstall] browser runtime can still install Chromium on first use after dependencies are complete.');
} else {
  console.log('[postinstall] installing playwright chromium...');
  try {
    execFileSync(process.execPath, [PLAYWRIGHT_CLI, 'install', 'chromium'], {
      stdio: 'inherit',
      timeout: 300_000,
      windowsHide: IS_WINDOWS,
    });

    if (IS_LINUX) {
      try {
        execFileSync(process.execPath, [PLAYWRIGHT_CLI, 'install-deps', 'chromium'], {
          stdio: 'inherit',
          timeout: 120_000,
        });
      } catch {
        console.warn('[postinstall] playwright install-deps skipped (may need sudo/root or may already be satisfied)');
      }
    }

    console.log('[postinstall] playwright chromium installed successfully');
  } catch (e) {
    console.warn('[postinstall] playwright chromium install failed (non-fatal):', e.message || e);
    console.warn('[postinstall] browser runtime will retry on first use. Manual recovery:');
    console.warn(`[postinstall]   ${process.execPath} ${PLAYWRIGHT_CLI} install chromium`);
    if (IS_LINUX) {
      console.warn(`[postinstall]   ${process.execPath} ${PLAYWRIGHT_CLI} install-deps chromium`);
    }
  }
}
