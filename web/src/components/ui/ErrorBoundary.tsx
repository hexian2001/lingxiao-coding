import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 p-6 font-mono">
          <AlertTriangle size={28} className="text-accent-yellow" />
          <p className="text-xs text-text-secondary text-center max-w-sm">Something went wrong</p>
          {this.state.error && (
            <pre className="text-[10px] text-accent-red/80 bg-error-bg rounded p-2 max-w-sm overflow-auto max-h-32 border border-accent-red/20">
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] rounded border border-border-default text-text-secondary hover:text-text-primary hover:border-border-muted transition-colors"
          >
            <RotateCcw size={12} />
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
