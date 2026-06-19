import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const requiredModeSplitKeys = [
  'chat.modeSplit.title',
  'chat.modeSplit.current',
  'chat.modeSplit.switchTo',
  'chat.modeSplit.permissionHint',
  'chat.modeSplit.collaborationTitle',
  'chat.modeSplit.collaborationLabel',
  'chat.modeSplit.routeTitle',
  'chat.modeSplit.routeLabel',
  'chat.modeSplit.pendingCollaboration',
  'chat.modeSplit.pendingRoute',
  'chat.modeSplit.collaborationSuccess',
  'chat.modeSplit.routeSuccess',
  'chat.modeSplit.errorCollaboration',
  'chat.modeSplit.errorRoute',
  'chat.modeSplit.noSnapshot',
  'chat.modeSplit.solo',
  'chat.modeSplit.team',
  'chat.modeSplit.auto',
  'chat.modeSplit.direct',
  'chat.modeSplit.hybrid',
  'chat.modeSplit.delegate',
  'chat.modeSplit.autoHint',
  'chat.modeSplit.directHint',
  'chat.modeSplit.delegateHint',
  'chat.modeSplit.soloHint',
  'chat.modeSplit.teamHint',
  'chat.modeSplit.routeDeviation',
];

function readLocale(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Record<string, unknown>;
}

test('mode split web i18n keys are complete in English and Chinese', () => {
  const en = readLocale('../i18n/locales/en.json');
  const zh = readLocale('../i18n/locales/zh.json');

  for (const key of requiredModeSplitKeys) {
    assert.equal(typeof en[key], 'string', `missing English key ${key}`);
    assert.equal(typeof zh[key], 'string', `missing Chinese key ${key}`);
    assert.notEqual(en[key], '', `empty English key ${key}`);
    assert.notEqual(zh[key], '', `empty Chinese key ${key}`);
  }
});
