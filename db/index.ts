import { env } from 'cloudflare:workers';
export function getDatabase() {
  if (!env.DB) throw new Error('Database unavailable');
  return env.DB;
}
