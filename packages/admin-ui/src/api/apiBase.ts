/**
 * Shared Admin UI API base URL resolution.
 *
 * Order of precedence:
 * 1) Vite build-time env: import.meta.env.VITE_API_URL
 * 2) Node/test env: process.env.VITE_API_URL
 * 3) Browser fallback: derive api-* from current admin-* host
 */
export function getApiBase(): string {
  const fromEnv = (import.meta as unknown as { env?: Record<string, string | undefined> })?.env?.VITE_API_URL;
  const fromProcess = typeof process !== 'undefined' ? process.env?.VITE_API_URL : undefined;

  const explicit = (fromEnv || fromProcess || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');

  if (typeof window !== 'undefined' && window.location?.host) {
    const host = window.location.host;
    const apiHost = host.replace(/^admin-/, 'api-').replace(/^admin\./, 'api.');
    return `${window.location.protocol}//${apiHost}`;
  }

  return '';
}

export const API_BASE = getApiBase();
