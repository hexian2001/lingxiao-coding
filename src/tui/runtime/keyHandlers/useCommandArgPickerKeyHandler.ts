import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { filterCommandArgItems, clampCommandArgCursor, type CommandArgItem } from '../../CommandArgPicker.js';
import type { KeyLike } from '../useTuiKeyController.js';

export interface CommandArgPickerState {
  commandName: string;
  items: CommandArgItem[];
  cursor: number;
  filter: string;
}

export interface CommandArgPickerKeyOptions {
  commandArgPickerStateRef: MutableRefObject<CommandArgPickerState | null>;
  setCommandArgPickerState: Dispatch<SetStateAction<CommandArgPickerState | null>>;
  inputBufferRef: MutableRefObject<string>;
  setInputBuffer: Dispatch<SetStateAction<string>>;
  handleSubmitRef: MutableRefObject<() => Promise<void>>;
}

/**
 * Returns true if the key was consumed by the command-arg picker.
 */
export function handleCommandArgPickerKey(
  key: KeyLike,
  opts: CommandArgPickerKeyOptions,
): boolean {
  const {
    commandArgPickerStateRef,
    setCommandArgPickerState,
    inputBufferRef,
    setInputBuffer,
    handleSubmitRef,
  } = opts;

  if (!commandArgPickerStateRef.current) return false;

  const pickerState = commandArgPickerStateRef.current;
  const filteredItems = filterCommandArgItems(pickerState.items, pickerState.filter);
  const clampedCursor = clampCommandArgCursor(pickerState.cursor, filteredItems.length);

  if (key.name === 'escape') {
    setCommandArgPickerState(null);
    return true;
  }
  if (key.name === 'return') {
    const item = filteredItems[clampedCursor];
    if (item) {
      const fullCmd = `${pickerState.commandName} ${item.name}`;
      setCommandArgPickerState(null);
      inputBufferRef.current = fullCmd;
      setInputBuffer(fullCmd);
      handleSubmitRef.current();
    } else {
      setCommandArgPickerState(null);
    }
    return true;
  }
  if (key.name === 'up') {
    setCommandArgPickerState((prev) => prev ? { ...prev, cursor: Math.max(0, prev.cursor - 1) } : null);
    return true;
  }
  if (key.name === 'down') {
    setCommandArgPickerState((prev) => {
      if (!prev) return null;
      const filtered = filterCommandArgItems(prev.items, prev.filter);
      return { ...prev, cursor: clampCommandArgCursor(prev.cursor + 1, filtered.length) };
    });
    return true;
  }
  if (key.name === 'backspace' || key.sequence === '\x7f') {
    setCommandArgPickerState((prev) => prev ? { ...prev, filter: prev.filter.slice(0, -1), cursor: 0 } : null);
    return true;
  }
  if (!key.ctrl && !key.meta && key.sequence && key.sequence.length === 1) {
    const num = parseInt(key.sequence, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= 9) {
      const item = filteredItems[num - 1];
      if (item) {
        const fullCmd = `${pickerState.commandName} ${item.name}`;
        setCommandArgPickerState(null);
        inputBufferRef.current = fullCmd;
        setInputBuffer(fullCmd);
        handleSubmitRef.current();
      }
      return true;
    }
    if (/^[a-zA-Z0-9_\-./]$/.test(key.sequence)) {
      const sequence = key.sequence;
      setCommandArgPickerState((prev) => prev ? { ...prev, filter: prev.filter + sequence, cursor: 0 } : null);
      return true;
    }
  }
  return true;
}
