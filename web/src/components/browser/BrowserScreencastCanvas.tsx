/**
 * BrowserScreencastCanvas — CDP screencast 实时浏览器画面
 *
 * 通过 WebSocket 接收 JPEG 帧并在 canvas 上渲染，
 * 同时转发鼠标/键盘事件到后端 CDP session。
 * 这是 Chrome DevTools 远程调试同款技术 — 完全原生体验。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getServerToken } from '../../api/headers';
import { useBrowserStore } from '../../stores/browserStore';
import { Loader2 } from 'lucide-react';

interface ScreencastCanvasProps {
  sessionId: string;
  width: number;
  height: number;
}

export function BrowserScreencastCanvas({ sessionId, width, height }: ScreencastCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshScreenshot = useBrowserStore((s) => s.refreshScreenshot);

  // Connect WebSocket
  useEffect(() => {
    const token = encodeURIComponent(getServerToken());
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/api/v1/browser/screencast/${sessionId}?token=${token}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      setError('WebSocket 连接失败');
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => { setConnected(false); };
    ws.onerror = () => setError('连接断开');

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'frame' && canvasRef.current) {
          const img = new Image();
          img.onload = () => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            // Set canvas size to frame size
            if (canvas.width !== img.width) canvas.width = img.width;
            if (canvas.height !== img.height) canvas.height = img.height;
            ctx.drawImage(img, 0, 0);
            setHasFrame(true);
          };
          img.src = `data:image/jpeg;base64,${msg.data}`;
        } else if (msg.type === 'error') {
          setError(msg.message);
        }
      } catch {}
    };

    return () => {
      ws.close();
    };
  }, [sessionId]);

  // Send input events
  const sendMsg = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // Coordinate mapping: canvas displayed size -> viewport coordinates
  const getCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  // Mouse events
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getCoords(e);
    sendMsg({ type: 'mouse', x, y, button: e.button === 2 ? 'right' : 'left', action: 'down' });
  };
  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getCoords(e);
    sendMsg({ type: 'mouse', x, y, button: e.button === 2 ? 'right' : 'left', action: 'up' });
  };
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getCoords(e);
    sendMsg({ type: 'mouse', x, y, action: 'move' });
  };
  const handleDblClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getCoords(e);
    sendMsg({ type: 'mouse', x, y, action: 'dblclick' });
  };
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const { x, y } = getCoords(e);
    sendMsg({ type: 'scroll', x, y, deltaX: e.deltaX, deltaY: e.deltaY });
  };
  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x, y } = getCoords(e);
    sendMsg({ type: 'mouse', x, y, button: 'right', action: 'click' });
  };

  // Keyboard events — forward all to CDP
  const handleKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (e.key.length === 1) {
      sendMsg({ type: 'key', key: e.key, action: 'down' });
    } else {
      sendMsg({ type: 'key', key: e.key, action: 'down' });
    }
  };
  const handleKeyUp = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    sendMsg({ type: 'key', key: e.key, action: 'up' });
  };
  const handleInput = (e: React.CompositionEvent<HTMLCanvasElement>) => {
    // For CJK input
    sendMsg({ type: 'type', text: e.data });
  };

  // Text input via invisible input
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Focus the hidden input when canvas is clicked to enable keyboard input
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('click', () => inputRef.current?.focus());
  }, [hasFrame]);

  return (
    <div ref={containerRef} className="browser-screencast-container" style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          cursor: 'default',
          display: hasFrame ? 'block' : 'none',
        }}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseMove={handleMouseMove}
        onWheel={handleWheel}
        onDoubleClick={handleDblClick}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onCompositionEnd={handleInput}
        tabIndex={0}
      />
      {/* Hidden input to capture keyboard + CJK */}
      <input
        ref={inputRef}
        style={{ position: 'absolute', left: -9999, opacity: 0 }}
        onInput={(e) => {
          const val = (e.target as HTMLInputElement).value;
          if (val) {
            sendMsg({ type: 'type', text: val });
            (e.target as HTMLInputElement).value = '';
          }
        }}
      />
      {!hasFrame && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8 }}>
          {connected ? (
            <><Loader2 size={24} className="animate-spin text-accent-brand" />
            <span className="text-[11px] text-text-tertiary">连接中...</span></>
          ) : error ? (
            <span className="text-[11px] text-accent-red">{error}</span>
          ) : (
            <><Loader2 size={24} className="animate-spin text-text-tertiary" />
            <span className="text-[11px] text-text-tertiary">等待画面...</span></>
          )}
        </div>
      )}
      {/* Connection indicator */}
      <div style={{ position: 'absolute', top: 4, right: 4, display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px', background: 'rgba(0,0,0,0.5)', borderRadius: 3 }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: connected ? '#22c55e' : '#ef4444' }} />
        <span style={{ fontSize: 9, color: '#fff', fontFamily: 'monospace' }}>{connected ? 'LIVE' : 'OFF'}</span>
      </div>
    </div>
  );
}
