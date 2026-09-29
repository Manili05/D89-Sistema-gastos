import { getSupabaseBrowserClient } from '@/lib/auth';

/** Extensions accepted by the `comprobantes` bucket, with the MIME Storage validates. */
export const RECEIPT_EXTENSIONS: Record<string, string> = {
  pdf: 'application/pdf', xml: 'application/xml', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp',
};
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

export function receiptExtension(name: string): string {
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
}

/** Storage validates MIME against the bucket list; some browsers send '' (e.g. for .xml). */
export function receiptMime(file: File): string {
  return RECEIPT_EXTENSIONS[receiptExtension(file.name)] || file.type;
}

/** Path layout the API requires: {work}/{owner (expense or income)}/{timestamp}-{id}-{name}. */
export function receiptPath(workId: string, ownerId: string, itemId: string, file: File): string {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-');
  return `${workId}/${ownerId}/${Date.now()}-${itemId}-${safeName}`;
}

/**
 * Upload one receipt. storage-js ignores `contentType` for File/Blob bodies and uses
 * the blob's own type, so the file is re-typed with the MIME the bucket accepts.
 */
export async function uploadReceipt(path: string, file: File): Promise<void> {
  const typed = new File([file], file.name, { type: receiptMime(file) });
  const { error } = await getSupabaseBrowserClient().storage.from('comprobantes')
    .upload(path, typed, { contentType: receiptMime(file), upsert: false });
  if (error) throw new Error(error.message);
}

/** Original file name from a stored path ({timestamp}-{item id}-{name}). */
export function receiptFileName(path: string): string {
  return path.split('/').pop()!.replace(/^\d+-((receipt|income-receipt)-\d+-)?/, '');
}

/** Open (new tab) or download a receipt through a short-lived signed URL. Read-only. */
export async function openSignedReceipt(path: string, download = false): Promise<void> {
  const { data, error } = await getSupabaseBrowserClient().storage.from('comprobantes')
    .createSignedUrl(path, 300, download ? { download: receiptFileName(path) } : undefined);
  if (error || !data) throw new Error(error?.message || 'No fue posible abrir el comprobante.');
  if (download) {
    const link = document.createElement('a');
    link.href = data.signedUrl;
    link.rel = 'noopener';
    link.click();
  } else {
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  }
}
