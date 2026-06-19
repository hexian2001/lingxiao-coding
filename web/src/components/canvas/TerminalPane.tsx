/**
 * TerminalPane — 交互式 xterm.js 终端
 *
 * 通过 WebSocket 连接后端 PTY，支持完整的终端交互：
 * - 用户输入 → WebSocket → PTY
 * - PTY 输出 → WebSocket → xterm.js
 * - 窗口大小调整
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';
import { getServerToken } from '../../api/headers';
import { useThemeStore } from '../../stores/themeStore';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

interface Props {
  terminalId: string;
}

type TerminalStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'lost';

export default function TerminalPane({ terminalId }: Props) {
  const { t } = useTranslation();
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);
  const disposedRef = useRef(false);
  const [status, setStatus] = useState<TerminalStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const sessionId = useSessionStore((s) => s.sessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const serverCwd = useSessionStore((s) => s.serverCwd);
  const workspace = sessions.find(s => s.id === sessionId)?.workspace || serverCwd || '/';
  const resolved = useThemeStore((s) => s.resolved);

  const xtermTheme = resolved === 'dark' ? {
    background: '#0a0a0f',
    foreground: '#a9b1d6',
    cursor: '#00ffaa',
    selectionBackground: '#00ffaa33',
    cursorAccent: '#0a0a0f',
    black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
    blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a',
    brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff', brightWhite: '#c0caf5',
  } : {
    background: '#f5f5fa',
    foreground: '#1a1a2e',
    cursor: '#00aa77',
    selectionBackground: '#00aa7733',
    cursorAccent: '#f5f5fa',
    black: '#1a1a2e', red: '#dd2255', green: '#00aa66', yellow: '#cc9900',
    blue: '#0088cc', magenta: '#7744dd', cyan: '#0088cc', white: '#555577',
    brightBlack: '#8888aa', brightRed: '#dd2255', brightGreen: '#00aa66',
    brightYellow: '#cc9900', brightBlue: '#0088cc', brightMagenta: '#7744dd',
    brightCyan: '#0088cc', brightWhite: '#1a1a2e',
  };

  // Initialize xterm.js + WebSocket PTY
  useEffect(() => {
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let disposed = false;
    disposedRef.current = false;

    const initTerminal = async () => {
      if (!terminalRef.current || disposed) return;

      try {
        // Dynamic import to avoid SSR issues
        const { Terminal } = await import('@xterm/xterm');
        const { FitAddon } = await import('@xterm/addon-fit');
        const { WebLinksAddon } = await import('@xterm/addon-web-links');

        await import('@xterm/xterm/css/xterm.css');

        term = new Terminal({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
          theme: xtermTheme,
        });

        fit = new FitAddon();
        term.loadAddon(fit);
        term.loadAddon(new WebLinksAddon());

        term.open(terminalRef.current);

        // Defer fit() to after xterm has fully rendered its viewport
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!disposed && fit) {
              try { fit.fit(); } catch (err) { console.warn('[TerminalPane] Initial terminal fit failed:', err); }
            }
          });
        });

        xtermRef.current = term;
        fitAddonRef.current = fit;

        // Handle terminal input → send to WebSocket
        term.onData((data: string) => {
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data }));
          }
        });

        // Connect to backend PTY via WebSocket with retry
        const connectWs = () => {
          if (disposedRef.current) return;
          setStatus('connecting');
          const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const wsUrl = `${wsProtocol}//${window.location.host}/api/v1/terminal/ws?token=${encodeURIComponent(getServerToken())}&cwd=${encodeURIComponent(workspace)}&sessionId=${encodeURIComponent(sessionId || '')}`;
          const ws = new WebSocket(wsUrl);
          wsRef.current = ws;

          ws.onopen = () => {
            if (disposedRef.current) { ws.close(); return; }
            retryCountRef.current = 0;
            setStatus('connected');
            setError(null);

            // Send initial terminal size
            if (fit) {
              try {
                const dims = fit.proposeDimensions();
                if (dims) {
                  ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
                }
              } catch (err) {
                console.warn('[TerminalPane] Failed to send initial terminal size:', err);
              }
            }
          };

          ws.onmessage = (event) => {
            if (disposedRef.current) return;
            try {
              const msg = JSON.parse(event.data);
              if (msg.type === 'output' && typeof msg.data === 'string') {
                term?.write(msg.data);
              } else if (msg.type === 'exit') {
                term?.writeln(`\r\n\x1b[33m[Process exited with code ${msg.exitCode}]\x1b[0m`);
                setStatus('disconnected');
              } else if (msg.type === 'error') {
                setError(msg.error);
                setStatus('lost');
              }
            } catch (err) {
              console.warn('[TerminalPane] Failed to handle terminal message:', err);
            }
          };

          ws.onclose = () => {
            if (disposedRef.current) return;
            // Auto-retry with backoff (max 5 attempts)
            if (retryCountRef.current < 5) {
              const delay = Math.min(1000 * Math.pow(2, retryCountRef.current), 10000);
              retryCountRef.current++;
              setStatus('connecting');
              retryTimerRef.current = setTimeout(connectWs, delay);
            } else {
              setStatus('disconnected');
              setError('Terminal connection lost. Click retry to reconnect.');
            }
          };

          ws.onerror = () => {
            // onclose will handle retry
          };
        };

        connectWs();

      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : 'Failed to initialize terminal');
          setStatus('lost');
        }
      }
    };

    initTerminal();

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (fitAddonRef.current && xtermRef.current) {
          try {
            fitAddonRef.current.fit();
            // Send resize to PTY
            const dims = fitAddonRef.current.proposeDimensions();
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN && dims) {
              ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
            }
          } catch (err) {
            console.warn('[TerminalPane] Failed to resize terminal:', err);
          }
        }
      });
    });

    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }

    return () => {
      disposedRef.current = true;
      disposed = true;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      resizeObserver.disconnect();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (term) term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [terminalId, workspace]);

  return (
    <div className="relative w-full h-full bg-bg-primary">
      {/* Terminal container */}
      <div ref={terminalRef} className="w-full h-full p-1" />

      {/* Error overlay */}
      {status === 'lost' && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg-primary/80 z-10">
          <div className="text-center">
            <AlertCircle className="w-6 h-6 text-accent-red mx-auto mb-2" />
            <p className="text-sm text-text-tertiary">
              {error || 'Terminal connection failed'}
            </p>
            <button
              onClick={() => {
                retryCountRef.current = 0;
                setError(null);
                setStatus('idle');
                // Re-trigger the effect by disposing and re-initializing
                if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
                if (xtermRef.current) { xtermRef.current.clear(); }
                // Reconnect
                const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsUrl = `${wsProtocol}//${window.location.host}/api/v1/terminal/ws?token=${encodeURIComponent(getServerToken())}&cwd=${encodeURIComponent(workspace)}&sessionId=${encodeURIComponent(sessionId || '')}`;
                setStatus('connecting');
                const ws = new WebSocket(wsUrl);
                wsRef.current = ws;
                ws.onopen = () => {
                  retryCountRef.current = 0;
                  setStatus('connected');
                  setError(null);
                  if (fitAddonRef.current) {
                    try {
                      const dims = fitAddonRef.current.proposeDimensions();
                      if (dims) ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
                    } catch (err) {
                      console.warn('[TerminalPane] Failed to send retry terminal size:', err);
                    }
                  }
                };
                ws.onmessage = (event) => {
                  try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'output' && typeof msg.data === 'string' && xtermRef.current) {
                      xtermRef.current.write(msg.data);
                    }
                  } catch (err) {
                    console.warn('[TerminalPane] Failed to handle retry terminal message:', err);
                  }
                };
                ws.onclose = () => { if (!disposedRef.current) setStatus('disconnected'); };
              }}
              className="mt-2 px-3 py-1 text-xs bg-accent-brand/20 text-accent-brand rounded hover:bg-accent-brand/30"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Connecting overlay */}
      {status === 'connecting' && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg-primary/50 z-10">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 border-2 border-accent-brand border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-accent-brand font-mono">CONNECTING...</span>
          </div>
        </div>
      )}

      {error && status !== 'lost' && (
        <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-accent-red/90 text-white text-xs flex items-center gap-2 z-10">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-text-primary/70 hover:text-text-primary">{t('common.close')}</button>
        </div>
      )}
    </div>
  );
}
