/**
 * 紧凑折线火花图:用于顶栏 token 消耗轨迹。
 * 纯 SVG、无依赖、确定性缩放(min/max 归一)。
 * 样本 < 2 不渲染(单点无轨迹)。
 */
interface TokenSparklineProps {
  data: number[];
  width?: number;
  height?: number;
}

export function TokenSparkline({ data, width = 40, height = 14 }: TokenSparklineProps) {
  if (data.length < 2) return null;
  let min = data[0];
  let max = data[0];
  for (const v of data) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const pad = 1.5; // 上下留 1.5px,避免贴边
  const innerH = height - pad * 2;
  const pts = data.map((v, i) => {
    const x = i * stepX;
    const y = pad + innerH - ((v - min) / range) * innerH;
    return [x, y] as const;
  });
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `0,${height} ${line} ${(data.length - 1) * stepX},${height}`;
  const gradId = 'tokenSparkGrad';
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="token-sparkline"
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-accent-brand)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="var(--color-accent-brand)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gradId})`} />
      <polyline
        points={line}
        fill="none"
        stroke="var(--color-accent-brand)"
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
