/**
 * Centralized error utilities for the Lingxiao CLI codebase.
 */

/**
 * Safely extract a string message from an unknown caught value.
 * Replaces the repeated `e instanceof Error ? e.message : String(e)` pattern.
 */
export function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {/* expected: fallback to default */
    return String(e);
  }
}
