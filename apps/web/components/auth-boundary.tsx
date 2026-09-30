'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/auth';

export function AuthBoundary({ children }: Readonly<{ children: React.ReactNode }>) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
      else router.replace('/login');
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        setReady(false);
        router.replace('/login');
      } else {
        setReady(true);
      }
    });
    return () => listener.subscription.unsubscribe();
  }, [router]);

  if (!ready) return <main className="session-loading" aria-live="polite">Verificando sesión…</main>;
  return children;
}
