import Link from 'next/link';
import { BuildingIcon, GridIcon, LockIcon, ReceiptIcon, UploadIcon } from './icons';

const nav = [
  { href: '/', label: 'Resumen', icon: GridIcon },
  { href: '/gastos', label: 'Gastos', icon: ReceiptIcon },
  { href: '/admin/importar', label: 'Importar', icon: UploadIcon },
  { href: '/cierres', label: 'Cierres', icon: LockIcon },
] as const;

export function AppShell({
  children,
  active,
}: Readonly<{ children: React.ReactNode; active: string }>) {
  return (
    <div className="app-frame">
      <aside className="sidebar">
        <Link href="/" className="brand" aria-label="D89 inicio">
          <span className="brand-mark">D89</span>
          <span><strong>Control de obra</strong><small>Arquitectura y diseño</small></span>
        </Link>
        <nav aria-label="Navegación principal">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className={active === href ? 'nav-link active' : 'nav-link'}>
              <Icon /> <span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-work">
          <span className="eyebrow">Obra activa</span>
          <div className="work-badge"><BuildingIcon /><span><strong>Infra Toluca</strong><small>3 áreas · 232 partidas</small></span></div>
        </div>
        <div className="user-card"><span className="avatar">SG</span><span><strong>Sergio Gómez</strong><small>Administrador</small></span></div>
      </aside>
      <main className="main-content">{children}</main>
      <nav className="mobile-nav" aria-label="Navegación móvil">
        {nav.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} className={active === href ? 'active' : ''}>
            <Icon size={19} /><span>{label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
