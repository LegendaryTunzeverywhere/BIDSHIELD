// Backend base URL for the SPA's /api calls. Empty string = same-origin (the
// API serves the SPA itself, as in the all-in-one deploy). Point this at a
// standalone backend origin when the frontend is hosted separately (e.g.
// Vercel): set VITE_API_URL at build time. Trailing slashes are stripped so
// `${API_BASE}/api/...` is always well-formed.
export const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
