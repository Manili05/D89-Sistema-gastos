import { apiFetch } from '@/lib/auth';

export const AI_MANUAL_FALLBACK = 'Puedes capturar los datos manualmente.';

const AI_ERRORS: Record<number, string> = {
  401: 'Tu sesión expiró. Vuelve a ingresar para usar la IA.',
  403: 'Tu cuenta no tiene permiso para usar esta función.',
  413: 'El archivo supera el límite de 10 MB.',
  415: 'El formato del archivo no es válido.',
  422: 'La solicitud no es válida.',
  429: 'Se agotó el presupuesto mensual de IA.',
  502: 'La IA no pudo leer el documento con certeza.',
  503: 'El servicio de IA no está disponible en este momento.',
};

/** Friendly, non-technical message for an AI endpoint status; `overrides` tailors it per feature. */
export function aiErrorMessage(status: number, overrides: Record<number, string> = {}): string {
  return overrides[status] || AI_ERRORS[status] || `La solicitud a la IA falló (${status}).`;
}

/**
 * Call an AI endpoint with the session JWT (via apiFetch). Network failures read as
 * "service unavailable"; aborts are rethrown untouched so callers can ignore them.
 */
export async function aiRequest<T>(
  path: string, init: RequestInit, overrides: Record<number, string> = {},
): Promise<T> {
  let response: Response;
  try {
    response = await apiFetch(path, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (error instanceof Error && error.message.includes('sesión')) throw error;
    throw new Error(aiErrorMessage(503, overrides));
  }
  if (!response.ok) throw new Error(aiErrorMessage(response.status, overrides));
  return response.json() as Promise<T>;
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
