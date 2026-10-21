const STORAGE_KEY = 'gsm2http.apiToken';
const UNAUTHORIZED_EVENT = 'gsm2http:unauthorized';

/**
 * The API token lives in this browser's localStorage, never in the page or in config.js:
 * those are served without authentication. Storage can be unavailable (private windows,
 * blocked site data); then the token lasts until the page is reloaded.
 */
let memoryToken: string | null = null;

export function getToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

export function setToken(token: string): void {
  memoryToken = token;
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // memory only
  }
}

export function clearToken(): void {
  memoryToken = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing stored
  }
}

/** Tells the token gate that the server rejected the token (it was rotated, or never set). */
export function notifyUnauthorized(): void {
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

export function onUnauthorized(listener: () => void): () => void {
  window.addEventListener(UNAUTHORIZED_EVENT, listener);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, listener);
}
