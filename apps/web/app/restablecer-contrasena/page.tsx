'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/auth';

export default function ResetPasswordPage() {
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    supabase.auth.getSession().then(({ data }) => setReady(Boolean(data.session)));
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || session) setReady(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password'));
    const confirmation = String(form.get('confirmation'));
    setError('');
    if (password.length < 10) {
      setError('La contraseña debe contener al menos 10 caracteres.');
      return;
    }
    if (password !== confirmation) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    setLoading(true);
    const supabase = getSupabaseBrowserClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setLoading(false);
      setError('El enlace expiró o no fue posible actualizar la contraseña.');
      return;
    }
    await supabase.auth.signOut();
    setLoading(false);
    setSuccess(true);
  }

  return (
    <main className="login-page reset-page">
      <section className="login-panel">
        <span className="login-brand">D89</span>
        <h1>Nueva contraseña</h1>
        <p>El enlace solo puede utilizarse durante su periodo de vigencia.</p>
        {success ? <div className="reset-success"><div className="notice success" role="status">Contraseña actualizada. Ya puedes iniciar sesión.</div><Link className="btn" href="/login">Volver al ingreso</Link></div> : ready ? <form onSubmit={submit}>
          {error ? <div className="notice error" role="alert">{error}</div> : null}
          <label className="field">Contraseña nueva<input name="password" type="password" autoComplete="new-password" minLength={10} required /></label>
          <label className="field">Confirmar contraseña<input name="confirmation" type="password" autoComplete="new-password" minLength={10} required /></label>
          <button className="btn" type="submit" disabled={loading}>{loading ? 'Actualizando…' : 'Guardar contraseña'}</button>
        </form> : <div className="notice error" role="alert">Enlace inválido o expirado. Solicita uno nuevo desde la pantalla de ingreso.</div>}
      </section>
      <aside className="login-art" aria-hidden="true"><div className="art-copy"><strong>Protege el acceso a la información de obra.</strong><p>Usa una contraseña única que no compartas con otros servicios.</p></div></aside>
    </main>
  );
}
