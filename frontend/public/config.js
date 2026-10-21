// Runtime configuration for the gsm2http web UI.
// Leave apiUrl empty to talk to the API on the same origin (the default for
// both the all-in-one and the nginx image). Override this file (for example
// with a bind mount) only when the UI is hosted apart from the API.
window.__GSM2HTTP_CONFIG__ = {
  apiUrl: '',
};
