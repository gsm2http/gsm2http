declare global {
  interface Window {
    __GSM2HTTP_CONFIG__?: { apiUrl?: string };
  }
}

/**
 * Same origin by default: the backend (or the nginx image) serves the UI and proxies
 * `/api` and `/socket.io`. A UI hosted apart from the API can point elsewhere at runtime
 * by overriding `/config.js`; nothing is baked in at build time.
 */
export const API_URL = (window.__GSM2HTTP_CONFIG__?.apiUrl ?? '').replace(/\/+$/, '');
