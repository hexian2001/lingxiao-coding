import { useTranslation } from 'react-i18next';
import type { PermissionRequest } from '../../stores/permissionStore';
import { usePermissionStore } from '../../stores/permissionStore';
import { AlertCircle, Shield, Check, X, ShieldCheck, ChevronDown, ChevronRight, Loader2, Wrench, ListOrdered } from 'lucide-react';
import { useState } from 'react';

interface Props {
  request: PermissionRequest;
  queuePosition?: number;
  queueTotal?: number;
}

export default function InterruptionBanner({ request, queuePosition = 1, queueTotal = 1 }: Props) {
  const { t } = useTranslation();
  const approve = usePermissionStore((s) => s.approve);
  const deny = usePermissionStore((s) => s.deny);
  const allowAll = usePermissionStore((s) => s.allowAll);
  const clearError = usePermissionStore((s) => s.clearError);
  const resolvingAction = usePermissionStore((s) => s.resolvingRequestIds[request.requestId]);
  const error = usePermissionStore((s) => s.errors[request.requestId]);
  const [showDetails, setShowDetails] = useState(false);
  const [confirmAllowAll, setConfirmAllowAll] = useState(false);
  const isResolving = Boolean(resolvingAction);

  const handleAllowAll = () => {
    if (!confirmAllowAll) {
      setConfirmAllowAll(true);
      return;
    }
    void allowAll(request.requestId);
  };

  return (
    <div className="border-t border-accent-yellow/30 bg-warning-bg px-4 py-3">
      <div className="flex items-center gap-3">
        <Shield size={18} className="text-accent-yellow flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <Wrench size={14} className="text-accent-blue" />
            <span className="font-mono text-accent-blue">{request.toolName}</span>
            {queueTotal > 1 && (
              <span
                className="inline-flex items-center gap-1 rounded border border-accent-yellow/40 bg-accent-yellow/15 px-1.5 py-0.5 text-[10px] font-mono text-accent-yellow"
                title={t('interruption.queueHint', `审批队列：第 ${queuePosition}/${queueTotal} 项，剩余 ${queueTotal - queuePosition} 项待处理`)}
              >
                <ListOrdered size={10} className="shrink-0" />
                {queuePosition}/{queueTotal}
              </span>
            )}
            {request.workerName && (
              <span className="text-xs text-text-tertiary">({request.workerName})</span>
            )}
          </div>
          {request.reason && (
            <div className="text-xs text-text-secondary mt-0.5 truncate">{request.reason}</div>
          )}
          {request.requestedMode && (
            <div className="text-xs text-text-tertiary mt-0.5">
              Mode: <span className="text-accent-yellow">{request.requestedMode}</span>
              {request.requestedHosts && request.requestedHosts.length > 0 && (
                <span> · Hosts: {request.requestedHosts.join(', ')}</span>
              )}
            </div>
          )}
        </div>
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="text-text-tertiary hover:text-text-secondary p-1"
          title={t('interruption.toggleDetails')}
          aria-label={showDetails ? t('interruption.hideDetails') : t('interruption.showDetails')}
        >
          {showDetails ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => { void approve(request.requestId); }}
            disabled={isResolving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent-green/20 text-accent-green hover:bg-accent-green/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {resolvingAction === 'approve' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {t('interruption.allow')}
          </button>
          <button
            onClick={handleAllowAll}
            disabled={isResolving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {resolvingAction === 'allowAll' ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            {confirmAllowAll ? t('interruption.allowAllConfirm') : t('interruption.allowAll')}
          </button>
          <button
            onClick={() => { void deny(request.requestId); }}
            disabled={isResolving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent-red/20 text-accent-red hover:bg-accent-red/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {resolvingAction === 'deny' ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
            {t('interruption.deny')}
          </button>
        </div>
      </div>

      {confirmAllowAll && !isResolving && (
        <div className="mt-2 ml-9 rounded-md border border-accent-blue/25 bg-accent-blue/10 px-2 py-1.5 text-xs text-accent-blue">
          {t('interruption.allowAllConfirmHint')}
        </div>
      )}

      {error && (
        <div className="mt-2 ml-9 flex items-start gap-1.5 rounded-md border border-accent-red/25 bg-accent-red/10 px-2 py-1.5 text-xs text-accent-red">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">
            {t('interruption.resolveFailed')}: {error}
          </span>
          <button
            type="button"
            onClick={() => clearError(request.requestId)}
            className="shrink-0 opacity-70 hover:opacity-100"
            aria-label={t('app.dismiss')}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Expanded details */}
      {showDetails && request.reason && (
        <div className="mt-2 ml-9 p-2 bg-bg-primary rounded-md border border-border-default">
          <pre className="text-xs text-text-secondary whitespace-pre-wrap break-all font-mono">
            {request.reason}
          </pre>
        </div>
      )}
    </div>
  );
}
