'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/auth';

export function SessionControls({ mobile = false }: Readonly<{ mobile?: boolean }>) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function logout() {
    setLoading(true);
    const { error } = await getSupabaseBrowserClient().auth.signOut();
    if (error) {
      setLoading(false);
      return;
    }
    router.replace('/login');
    router.refresh();
  }

  return <button className={mobile ? 'mobile-logout' : 'logout-button'} type="button" onClick={logout} disabled={loading} aria-label="Cerrar sesión">{loading ? 'Saliendo…' : 'Cerrar sesión'}</button>;
}
