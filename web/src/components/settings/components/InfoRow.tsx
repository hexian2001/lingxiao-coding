export function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-text-tertiary w-20 shrink-0">{label}</span>
      <span className="text-text-primary font-mono truncate">{value}</span>
    </div>
  );
}
