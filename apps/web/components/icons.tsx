type IconProps = { size?: number };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export function GridIcon({ size = 20 }: IconProps) {
  return <svg {...base(size)}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>;
}
export function ReceiptIcon({ size = 20 }: IconProps) {
  return <svg {...base(size)}><path d="M6 2h12v20l-3-2-3 2-3-2-3 2Z"/><path d="M9 7h6M9 11h6M9 15h4"/></svg>;
}
export function UploadIcon({ size = 20 }: IconProps) {
  return <svg {...base(size)}><path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M4 15v5h16v-5"/></svg>;
}
export function LockIcon({ size = 20 }: IconProps) {
  return <svg {...base(size)}><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>;
}
export function BuildingIcon({ size = 20 }: IconProps) {
  return <svg {...base(size)}><path d="M4 21V6l8-4 8 4v15M8 9h2m4 0h2M8 13h2m4 0h2M9 21v-4h6v4"/></svg>;
}
export function ArrowIcon({ size = 18 }: IconProps) {
  return <svg {...base(size)}><path d="m9 18 6-6-6-6"/></svg>;
}
export function PlusIcon({ size = 18 }: IconProps) {
  return <svg {...base(size)}><path d="M12 5v14M5 12h14"/></svg>;
}
