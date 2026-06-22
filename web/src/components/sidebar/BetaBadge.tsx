export function BetaBadge({ className = '' }: { className?: string }) {
  return (
    <span
      className={`
        px-1.5 py-0.5 
        text-[9px] font-medium uppercase tracking-wider
        border rounded-sm
        bg-accent-cinnabar/10 text-accent-cinnabar border-accent-cinnabar/30
        ${className}
      `.trim().replace(/\s+/g, ' ')}
    >
      Beta
    </span>
  );
}
