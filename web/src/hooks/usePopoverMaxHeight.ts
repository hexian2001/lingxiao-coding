import { useLayoutEffect, useState, type RefObject } from 'react';

interface UsePopoverMaxHeightOptions {
  /** Pixels of gap between the trigger top and the popover panel. */
  gap?: number;
  /** Pixels reserved at the top of the viewport (top bar, etc.). */
  topMargin?: number;
  /** Largest desired panel height regardless of available space. */
  cap?: number;
}

/**
 * Measures the vertical space available ABOVE a trigger element and returns a
 * clamped `maxHeight` (px) for an upward-opening popover anchored to it.
 *
 * Deterministic: reads live layout via getBoundingClientRect + window
 * dimensions on every open / resize / scroll, then clamps. The panel simply
 * never grows past the real space above it, so it cannot cover or overflow the
 * content above the composer the way a fixed `h-[420px]` + `bottom-8` does.
 *
 * Runs in useLayoutEffect (before paint), so the clamped value is what the user
 * sees — no full-size flash. Returns null while closed or before the first
 * measurement lands; pair with a defensive `max-h-[85vh]` class.
 */
export function usePopoverMaxHeight(
  triggerRef: RefObject<HTMLElement | null>,
  open: boolean,
  options: UsePopoverMaxHeightOptions = {},
): number | null {
  const { gap = 4, topMargin = 8, cap = Infinity } = options;
  const [maxHeight, setMaxHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setMaxHeight(null);
      return;
    }
    const el = triggerRef.current;
    if (!el) return;

    const measure = () => {
      const spaceAbove = el.getBoundingClientRect().top - topMargin;
      setMaxHeight(Math.max(0, Math.min(cap, spaceAbove - gap)));
    };

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, triggerRef, gap, topMargin, cap]);

  return maxHeight;
}
