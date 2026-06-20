import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'warning' | 'info';
  duration?: number;
  action?: ToastAction;
}

interface ToastContextValue {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = crypto.randomUUID();
      const duration = toast.duration ?? 3000;
      setToasts((prev) => [...prev, { ...toast, id }]);
      if (duration > 0) {
        setTimeout(() => removeToast(id), duration);
      }
    },
    [removeToast],
  );

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  );
}

const typeStyles: Record<Toast['type'], string> = {
  success: 'border-accent-green/40 bg-success-bg text-accent-green',
  error: 'border-accent-red/40 bg-error-bg text-accent-red',
  warning: 'border-accent-yellow/40 bg-warning-bg text-accent-yellow',
  info: 'border-accent-blue/40 bg-info-bg text-accent-blue',
};

const typeIcons: Record<Toast['type'], string> = {
  success: '\u2713',
  error: '\u2717',
  warning: '\u26A0',
  info: '\u2139',
};

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex items-center gap-2 px-3 py-2 rounded border font-mono text-xs animate-fade-in ${typeStyles[toast.type]}`}
        >
          <span className="text-sm shrink-0">{typeIcons[toast.type]}</span>
          <span className="flex-1 break-words">{toast.message}</span>
          {toast.action && (
            <button
              onClick={() => {
                toast.action!.onClick();
                onDismiss(toast.id);
              }}
              className="shrink-0 px-2 py-0.5 rounded border border-current opacity-80 hover:opacity-100 transition-opacity font-semibold whitespace-nowrap"
            >
              {toast.action.label}
            </button>
          )}
          <button
            onClick={() => onDismiss(toast.id)}
            className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
          >
            \u2715
          </button>
        </div>
      ))}
    </div>
  );
}
