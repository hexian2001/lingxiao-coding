import { type ReactNode, useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface ConfirmationDialogProps {
  open: boolean;
  title: string;
  message: string | ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'default';
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmationDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      className="bg-transparent p-0 m-auto backdrop:bg-black/50"
      onClose={onCancel}
      onClick={(e) => {
        if (e.target === dialogRef.current) onCancel();
      }}
    >
      <div className="bg-bg-card border border-border-default rounded-lg shadow-lg max-w-md w-full p-4 font-mono animate-fade-in">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-text-primary">{title}</h3>
          <button onClick={onCancel} className="text-text-tertiary hover:text-text-primary transition-colors">
            <X size={14} />
          </button>
        </div>
        <div className="text-xs text-text-secondary mb-4 leading-relaxed">{message}</div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-[11px] rounded border border-border-default text-text-secondary hover:text-text-primary hover:border-border-muted transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`px-3 py-1.5 text-[11px] rounded border transition-colors ${
              variant === 'danger'
                ? 'border-accent-red/40 bg-accent-red/10 text-accent-red hover:bg-accent-red/20'
                : 'border-accent-brand/40 bg-accent-brand/10 text-accent-brand hover:bg-accent-brand/20'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
