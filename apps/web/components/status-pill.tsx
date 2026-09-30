export function StatusPill({ tone, children }: Readonly<{ tone: 'green' | 'amber' | 'red' | 'navy'; children: React.ReactNode }>) {
  return <span className={`status-pill ${tone}`}><i />{children}</span>;
}
