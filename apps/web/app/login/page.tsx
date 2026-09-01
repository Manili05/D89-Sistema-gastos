'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseBrowserClient } from '@/lib/auth';

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [email, setEmail] = useState('');

  useEffect(() => {
    getSupabaseBrowserClient().auth.getSession().then(({ data }) => {
      if (data.session) router.replace('/');
    });
  }, [router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setLoading(true);
    setError('');
    setMessage('');
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

  async function recoverPassword() {
    setError('');
    setMessage('');
    if (!email || !email.includes('@')) {
      setError('Escribe primero un correo electrónico válido.');
      return;
    }
    setRecovering(true);
    const { error: recoveryError } = await getSupabaseBrowserClient().auth.resetPasswordForEmail(
      email,
      { redirectTo: `${window.location.origin}/restablecer-contrasena` },
    );
    setRecovering(false);
    if (recoveryError) {
      setError('No fue posible enviar el correo de recuperación. Contacta al administrador.');
      return;
    }
    setMessage('Si la cuenta existe, recibirás un enlace para crear una contraseña nueva.');
  }

  return (
    <main className="login-page">
      <section className="login-panel">
        <span className="login-brand">D89</span>
        <h1>Control claro.<br />Decisiones a tiempo.</h1>
        <p>Ingresa al sistema de presupuesto y gastos de obra de Distrito 89.</p>
        {error ? <div className="notice error" role="alert">{error}</div> : null}
        {message ? <div className="notice success" role="status">{message}</div> : null}
        <form onSubmit={submit}>
          <label className="field">Correo electrónico<input name="email" type="email" autoComplete="email" placeholder="nombre@d89.mx" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
          <label className="field">Contraseña<input name="password" type="password" autoComplete="current-password" placeholder="••••••••" required /></label>
          <button type="submit" className="btn" disabled={loading}>{loading ? 'Ingresando…' : 'Ingresar al sistema'}</button>
          <button className="btn ghost" type="button" onClick={recoverPassword} disabled={recovering}>{recovering ? 'Enviando enlace…' : '¿Olvidaste tu contraseña?'}</button>
        </form>
      </section>
      <aside className="login-art" aria-hidden="true"><div className="art-copy"><strong>La obra se entiende mejor cuando los números tienen contexto.</strong><p>Presupuesto vigente, evidencia y variación en una sola vista.</p></div></aside>
    </main>
  );
}
