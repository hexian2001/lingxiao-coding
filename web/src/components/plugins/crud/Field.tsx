import type { ReactNode } from 'react';

/**
 * Labeled-field wrapper — the de-facto standard used by UserToolForm /
 * McpServerForm (each previously held its own copy). Extracted so the new
 * skill / command / agent forms share one.
 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-text-secondary mb-1">{label}</span>
      {children}
    </label>
  );
}
