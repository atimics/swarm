import { API_BASE } from '../api/apiBase';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getErrorName(error: unknown): string {
  const anyErr = error as { name?: unknown };
  return typeof anyErr?.name === 'string' ? anyErr.name : '';
}

export function isNetworkFetchError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return message === 'Failed to fetch' || /networkerror|load failed/i.test(message);
}

export function humanizeApiUnreachable(error: unknown): string | null {
  if (!isNetworkFetchError(error)) return null;
  const apiHint = API_BASE ? ` (${API_BASE})` : '';
  return `Couldn't reach the API${apiHint}. If you're on staging, you may need Cloudflare Access for the API subdomain — open the API URL in a new tab, then retry.`;
}

export function isPhantomExtensionContextInvalidatedError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return (
    /extension context invalidated/i.test(message) ||
    /failed to send message to service worker/i.test(message) ||
    /phantom\].*service worker/i.test(message)
  );
}

export function isUserRejectedSignatureError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return /user rejected|rejected|declined|cancell?ed/i.test(message);
}

export function humanizeWalletSignatureError(error: unknown): string {
  const name = getErrorName(error);
  const message = getErrorMessage(error);

  if (isPhantomExtensionContextInvalidatedError(error)) {
    return `Phantom looks like it restarted (extension context invalidated). Try: unlock Phantom, reload this page, then click Sign again. (${message})`;
  }

  if (isUserRejectedSignatureError(error)) {
    return `Signature was cancelled in Phantom. (${message})`;
  }

  if (name.includes('Wallet') && /unexpected error/i.test(message)) {
    return `Phantom returned an unexpected error while signing. Try: unlock Phantom, approve the signature prompt, then disconnect/reconnect the wallet. If it persists, restart Chrome. (${message})`;
  }

  return message || 'Wallet signature failed';
}
