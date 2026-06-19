export interface PickerWindowResult<T> {
  start: number;
  end: number;
  visibleItems: T[];
  hiddenAbove: number;
  hiddenBelow: number;
}

export function getPickerWindow<T>(
  items: T[],
  selectedIndex: number,
  visibleRows: number,
): PickerWindowResult<T> {
  if (items.length === 0) {
    return {
      start: 0,
      end: 0,
      visibleItems: [],
      hiddenAbove: 0,
      hiddenBelow: 0,
    };
  }

  const clampedVisibleRows = Math.max(1, visibleRows);
  const safeSelectedIndex = Math.max(0, Math.min(items.length - 1, selectedIndex));
  const start = Math.max(
    0,
    Math.min(
      Math.max(0, items.length - clampedVisibleRows),
      safeSelectedIndex - Math.floor(clampedVisibleRows / 2),
    ),
  );
  const end = Math.min(items.length, start + clampedVisibleRows);

  return {
    start,
    end,
    visibleItems: items.slice(start, end),
    hiddenAbove: start,
    hiddenBelow: Math.max(0, items.length - end),
  };
}
