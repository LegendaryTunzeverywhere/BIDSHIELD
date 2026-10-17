// Vercel's /api rewrite keeps the session cookie first-party; do not bypass it
// with VITE_API_URL, even if that variable is present in the build environment.
// Other split deployments can still point directly at a backend origin.
const useVercelProxy =
  typeof window !== 'undefined' && window.location.hostname.endsWith('.vercel.app');

export const API_BASE = (
  useVercelProxy ? '' : import.meta.env.VITE_API_URL || ''
).replace(/\/+$/, '');
