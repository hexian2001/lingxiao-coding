#!/usr/bin/env node
/**
 * Classify open CodeQL alerts into a reviewable noise-reduction plan.
 *
 * Default mode is read-only:
 *   node scripts/triage-codeql-alerts.mjs
 *
 * To write JSON/Markdown reports:
 *   node scripts/triage-codeql-alerts.mjs --write-report
 *
 * To dismiss the reviewed noise buckets:
 *   GITHUB_TOKEN=... node scripts/triage-codeql-alerts.mjs --apply
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const OUTPUT_DIR = join(REPO_ROOT, 'docs', 'maintenance', 'generated');
const JSON_OUTPUT = join(OUTPUT_DIR, 'codeql-alert-triage.json');
const MD_OUTPUT = join(OUTPUT_DIR, 'codeql-alert-triage.md');

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const WRITE_REPORT = args.has('--write-report');
const DISMISS_CONCURRENCY = Number.parseInt(process.env.CODEQL_TRIAGE_DISMISS_CONCURRENCY || '8', 10);
const OWNER_REPO = process.env.GITHUB_REPOSITORY || 'hexian2001/lingxiao-coding';
const TOKEN = resolveGithubToken();
const API = 'https://api.github.com';

const rateLimitRules = new Set(['js/missing-rate-limiting']);
const configSuppressedRules = new Set([
  'js/missing-rate-limiting',
  'js/useless-regexp-character-escape',
  'js/double-escaping',
]);

const fixSimpleRules = new Set([
  'js/incomplete-multi-character-sanitization',
  'js/incomplete-sanitization',
  'js/incomplete-url-scheme-check',
  'js/incomplete-url-substring-sanitization',
]);

const currentBatchDismissRules = [
  {
    id: 'js/polynomial-redos',
    dismissalReason: 'won\'t fix',
    reason: 'Current instances are low-signal ReDoS findings in bounded local parsing/normalization paths; keep future instances visible and revisit if they hit exposed request hot paths.',
  },
  {
    id: 'js/insecure-randomness',
    dismissalReason: 'false positive',
    reason: 'Current instances use Math.random for non-secret correlation IDs, jitter, or display state rather than authentication, authorization, or cryptographic material.',
  },
  {
    id: 'js/bad-tag-filter',
    dismissalReason: 'won\'t fix',
    reason: 'Current instances are best-effort text preview cleanup, not the hardened HTML trust boundary; remaining sanitizer alerts keep XSS review visible.',
  },
];

function authHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  return headers;
}

function resolveGithubToken() {
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) return envToken;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

async function github(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function fetchOpenAlerts() {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const batch = await github(`/repos/${OWNER_REPO}/code-scanning/alerts?state=open&per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

function location(alert) {
  const loc = alert.most_recent_instance?.location || {};
  return {
    path: loc.path || '',
    line: loc.start_line || 0,
  };
}

function bucketFor(alert) {
  const rule = alert.rule?.id || '';
  const loc = location(alert);
  const path = loc.path;

  if (rateLimitRules.has(rule)) {
    return {
      bucket: 'dismiss_false_positive',
      dismissalReason: 'false positive',
      reason: 'Global /api preHandler rate limit is implemented in src/server.ts; CodeQL does not recognize the project-specific Fastify hook.',
    };
  }

  if (rule === 'js/path-injection') {
    return {
      bucket: 'dismiss_wont_fix',
      dismissalReason: 'won\'t fix',
      reason: path.startsWith('src/web-server/')
        ? 'Authenticated local workspace API path flow under LingXiao single-user product boundary; hardened-mode/root checks cover stricter deployments where applicable.'
        : 'Internal local workspace/session/plugin path flow under LingXiao single-user trust boundary; track boundary hardening separately.',
    };
  }

  if (configSuppressedRules.has(rule)) {
    return {
      bucket: 'dismiss_false_positive',
      dismissalReason: 'false positive',
      reason: 'Suppressed in CodeQL config because it is noisy for the current product boundary.',
    };
  }

  const currentBatchDismiss = currentBatchDismissRules.find((entry) => entry.id === rule);
  if (currentBatchDismiss) {
    return {
      bucket: currentBatchDismiss.dismissalReason === 'false positive' ? 'dismiss_false_positive' : 'dismiss_wont_fix',
      dismissalReason: currentBatchDismiss.dismissalReason,
      reason: currentBatchDismiss.reason,
    };
  }

  if (rule === 'js/clear-text-logging' && path.endsWith('src/test-llm-request.ts')) {
    return {
      bucket: 'dismiss_used_in_tests',
      dismissalReason: 'used in tests',
      reason: 'Diagnostic developer-only test script; not shipped as the runtime credential handling path.',
    };
  }

  if (fixSimpleRules.has(rule)) {
    return {
      bucket: 'fix_simple',
      reason: 'Small targeted code cleanup is likely cheaper than carrying the alert.',
    };
  }

  return {
    bucket: 'keep_open',
    reason: 'Needs manual security review.',
  };
}

function simplify(alert) {
  const loc = location(alert);
  const triage = bucketFor(alert);
  return {
    number: alert.number,
    htmlUrl: alert.html_url,
    rule: alert.rule?.id || '',
    securitySeverity: alert.rule?.security_severity_level || alert.rule?.severity || '',
    path: loc.path,
    line: loc.line,
    message: alert.most_recent_instance?.message?.text || '',
    ...triage,
  };
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

function renderMarkdown(items) {
  const byBucket = groupBy(items, (item) => item.bucket);
  const byRule = groupBy(items, (item) => item.rule);
  const byPath = groupBy(items, (item) => item.path).slice(0, 30);
  const generatedAt = new Date().toISOString();

  const lines = [
    '# CodeQL Alert Triage',
    '',
    `Generated at: ${generatedAt}`,
    `Repository: ${OWNER_REPO}`,
    `Open alerts analyzed: ${items.length}`,
    '',
    '## Bucket Summary',
    '',
    '| Bucket | Count |',
    '| --- | ---: |',
    ...byBucket.map(([bucket, count]) => `| ${bucket} | ${count} |`),
    '',
    '## Rule Summary',
    '',
    '| Rule | Count |',
    '| --- | ---: |',
    ...byRule.map(([rule, count]) => `| ${rule} | ${count} |`),
    '',
    '## Top Paths',
    '',
    '| Path | Count |',
    '| --- | ---: |',
    ...byPath.map(([path, count]) => `| ${path} | ${count} |`),
    '',
    '## Dismissal Plan',
    '',
    '| Bucket | Rule | Location | Reason |',
    '| --- | --- | --- | --- |',
    ...items
      .filter((item) => item.bucket.startsWith('dismiss_'))
      .sort((a, b) => b.number - a.number)
      .map((item) => `| ${item.bucket} | ${item.rule} | [#${item.number}](${item.htmlUrl}) ${item.path}:${item.line} | ${item.reason.replaceAll('|', '\\|')} |`),
    '',
    '## Remaining Work',
    '',
    '| Bucket | Rule | Location | Reason |',
    '| --- | --- | --- | --- |',
    ...items
      .filter((item) => !item.bucket.startsWith('dismiss_'))
      .sort((a, b) => b.number - a.number)
      .map((item) => `| ${item.bucket} | ${item.rule} | [#${item.number}](${item.htmlUrl}) ${item.path}:${item.line} | ${item.reason.replaceAll('|', '\\|')} |`),
    '',
  ];
  return lines.join('\n');
}

function printItems(title, items) {
  if (items.length === 0) return;
  console.log(`\n${title}`);
  for (const item of items.sort((a, b) => b.number - a.number)) {
    console.log(`#${item.number}\t${item.bucket}\t${item.rule}\t${item.path}:${item.line}`);
  }
}

async function dismiss(item) {
  await github(`/repos/${OWNER_REPO}/code-scanning/alerts/${item.number}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state: 'dismissed',
      dismissed_reason: item.dismissalReason,
      dismissed_comment: item.reason,
    }),
  });
}

async function runPool(items, worker) {
  const concurrency = Math.max(1, Math.min(DISMISS_CONCURRENCY, items.length || 1));
  let index = 0;
  const failures = [];
  async function next() {
    while (index < items.length) {
      const item = items[index++];
      try {
        await worker(item);
      } catch (err) {
        failures.push({ item, err });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => next()));
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(
        `Failed to dismiss #${failure.item.number}: ${
          failure.err instanceof Error ? failure.err.message : String(failure.err)
        }`,
      );
    }
    throw new Error(`Failed to dismiss ${failures.length} alerts.`);
  }
}

async function main() {
  if (APPLY && !TOKEN) {
    throw new Error('--apply requires GITHUB_TOKEN or GH_TOKEN.');
  }

  const alerts = await fetchOpenAlerts();
  const items = alerts.map(simplify);

  console.log(`Analyzed ${items.length} open CodeQL alerts.`);
  for (const [bucket, count] of groupBy(items, (item) => item.bucket)) {
    console.log(`${bucket}: ${count}`);
  }

  if (WRITE_REPORT) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(JSON_OUTPUT, `${JSON.stringify({ repository: OWNER_REPO, generatedAt: new Date().toISOString(), alerts: items }, null, 2)}\n`);
    writeFileSync(MD_OUTPUT, renderMarkdown(items));
    console.log(`Wrote ${JSON_OUTPUT}`);
    console.log(`Wrote ${MD_OUTPUT}`);
  }
  printItems('Remaining work', items.filter((item) => !item.bucket.startsWith('dismiss_')));

  if (APPLY) {
    const dismissible = items.filter((item) => item.bucket.startsWith('dismiss_'));
    await runPool(dismissible, async (item) => {
      console.log(`Dismissing #${item.number} ${item.rule} ${item.path}:${item.line}`);
      await dismiss(item);
    });
    console.log(`Dismissed ${dismissible.length} alerts.`);
  } else {
    console.log('Dry run only. Re-run with --apply to dismiss reviewed noise buckets.');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
