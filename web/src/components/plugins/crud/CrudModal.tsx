import type { ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * Centered modal shell for CRUD forms — mirrors the overlay+card+footer
 * structure duplicated across UserToolForm / McpServerForm.
 */
export function CrudModal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="lx-overlay p-4">
      <div className="bg-bg-primary border border-border-default rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="px-4 py-3 border-b border-border-default flex items-center justify-between">
          <h3 className="text-sm font-medium text-text-primary">{title}</h3>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">{children}</div>
        <div className="px-4 py-3 border-t border-border-default flex items-center justify-end gap-2">{footer}</div>
      </div>
    </div>
  );
}
