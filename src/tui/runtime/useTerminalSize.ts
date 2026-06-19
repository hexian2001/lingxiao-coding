import { useEffect, useState } from 'react';

interface TerminalSize {
  rows: number;
  cols: number;
}

interface TerminalOutput {
  rows?: number;
  columns?: number;
  on?: (event: 'resize', listener: () => void) => void;
  off?: (event: 'resize', listener: () => void) => void;
}

export function useTerminalSize(stdout: TerminalOutput | undefined): TerminalSize {
  const [termSize, setTermSize] = useState<TerminalSize>({
    rows: stdout?.rows || 24,
    cols: stdout?.columns || 80,
  });

  useEffect(() => {
    const update = () => {
      if (stdout) {
        setTermSize({ rows: stdout.rows || 24, cols: stdout.columns || 80 });
      }
    };
    update();
    stdout?.on?.('resize', update);
    return () => {
      stdout?.off?.('resize', update);
    };
  }, [stdout]);

  return termSize;
}
