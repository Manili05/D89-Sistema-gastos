import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | undefined;

export function getSupabaseBrowserClient(): SupabaseClient {
  if (client) return client;
  // Auth, Storage and PostgREST share the public reverse-proxy origin. Keeping
  // this relative also makes temporary preview URLs work without rebuilding.
  const url = window.location.origin;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'd89-ci-placeholder';
  client = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

export async function accessToken(): Promise<string> {
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Tu sesión expiró. Vuelve a ingresar.');
  return token;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  return fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api/v1'}${path}`, { ...init, headers });
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { detail?: string };
    throw new Error(payload.detail || `Solicitud rechazada (${response.status})`);
  }
  return response.json() as Promise<T>;
}
