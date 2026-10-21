import { t, getLocale, localizePayload, LocalizedError, isDescriptor } from '../../../packages/i18n/src/index';
/** The browser speaks application contracts, never provider-specific endpoints. */
export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers); headers.set('Accept-Language', getLocale());
  const response = await fetch(url, { ...init, headers });
  const value = localizePayload(await response.json());
  if (!response.ok && typeof value.code === 'string' && isDescriptor({ key: value.code })) throw new LocalizedError(value.code as Parameters<typeof t>[0], value.params);
  if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : value.error ?? t('ui.api.the-service-request-failed'));
  return value as T;
}
export const jsonBody = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
