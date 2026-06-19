import type { MutableRefObject } from 'react';
import type { KeyLike } from '../useTuiKeyController.js';

export interface NavigationKeyOptions {
  handleTabSwitchRef: MutableRefObject<(direction: 'next' | 'prev') => void>;
  navigateInputHistory: (direction: 'up' | 'down') => boolean;
  switchTabRef: MutableRefObject<(name: string) => void>;
  inputBufferRef: MutableRefObject<string>;
}

/** Handle tab key for channel switching. Returns true if consumed. */
export function handleTabKey(key: KeyLike, opts: NavigationKeyOptions, hasSuggestions: boolean): 'next' | 'prev' | 'suggestion' | false {
  if (key.name !== 'tab') return false;
  if (key.shift) return 'prev';
  if (hasSuggestions) return 'suggestion';
  return 'next';
}

/** Navigate input history (up/down when no modal or suggestions). Returns true if consumed. */
export function handleHistoryNavigation(key: KeyLike, opts: NavigationKeyOptions): boolean {
  if (key.name === 'up') return opts.navigateInputHistory('up');
  if (key.name === 'down') return opts.navigateInputHistory('down');
  return false;
}

/** Alt+number shortcuts for panel switching. Returns true if consumed. */
export function handleAltShortcut(key: KeyLike, opts: NavigationKeyOptions): boolean {
  if (!key.meta || opts.inputBufferRef.current.length !== 0) return false;
  if (key.name === '1') {
    opts.switchTabRef.current('main');
    return true;
  }
  return false;
}
