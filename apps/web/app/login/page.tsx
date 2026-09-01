'use client';

import { type FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowserClient } from '@/lib/auth';

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setLoading(true);
    setError('');
    const { error: authError } = await getSupabaseBrowserClient().auth.signInWithPassword({
      email: String(form.get('email')),
      password: String(form.get('password')),
    });
    setLoading(false);
    if (authError) {
      setError('No fue posible iniciar sesión. Revisa tus credenciales.');
      return;
    }
    router.push('/');
    router.refresh();
  }

  return (
    <main className="login-page">
      <section className="login-panel">
        <span className="login-brand">D89</span>
        <h1>Control claro.<br />Decisiones a tiempo.</h1>
        <p>Ingresa al sistema de presupuesto y gastos de obra de Distrito 89.</p>
        {error ? <div className="notice error" role="alert">{error}</div> : null}
        <form onSubmit={submit}>
          <label className="field">Correo electrónico<input name="email" type="email" autoComplete="email" placeholder="nombre@d89.mx" required /></label>
          <label className="field">Contraseña<input name="password" type="password" autoComplete="current-password" placeholder="••••••••" required /></label>
          <button type="submit" className="btn" disabled={loading}>{loading ? 'Ingresando…' : 'Ingresar al sistema'}</button>
          <button className="btn ghost" type="button">¿Olvidaste tu contraseña?</button>
        </form>
      </section>
      <aside className="login-art" aria-hidden="true"><div className="art-copy"><strong>La obra se entiende mejor cuando los números tienen contexto.</strong><p>Presupuesto vigente, evidencia y variación en una sola vista.</p></div></aside>
    </main>
  );
}
