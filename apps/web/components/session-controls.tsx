'use client';

import { useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/auth';

export function SessionControls({ mobile = false }: Readonly<{ mobile?: boolean }>) {
  const [loading, setLoading] = useState(false);

  async function logout() {
    setLoading(true);
    const { error } = await getSupabaseBrowserClient().auth.signOut();
    if (error) {
      setLoading(false);
      return;
    }
    window.location.replace('/login');
  }

  return <button className={mobile ? 'mobile-logout' : 'logout-button'} type="button" onClick={logout} disabled={loading} aria-label="Cerrar sesión">{loading ? 'Saliendo…' : 'Cerrar sesión'}</button>;
}
