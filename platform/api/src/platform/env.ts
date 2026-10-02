import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Loads `.env` from the working directory for local development and tests. Never in production (secrets come from the environment / secret
 * store there), and never overrides a variable that is already set, so a real environment always wins over the file.
 */
export function loadDotEnv(dir = process.cwd(), env: NodeJS.ProcessEnv = process.env, loader: (p: string) => void = (p) => (process as any).loadEnvFile(p)): boolean {
  if (env.NODE_ENV === 'production') return false;
  const file = join(dir, '.env');
  if (!existsSync(file) || typeof (process as any).loadEnvFile !== 'function') return false;
  const before = { ...env }; loader(file);
  for (const k of Object.keys(before)) if (env[k] !== before[k]) env[k] = before[k]; // belt and braces: restore anything the loader changed
  return true;
}
