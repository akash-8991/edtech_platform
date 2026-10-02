import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * Loads secrets from a managed secret store into process.env BEFORE the application module is evaluated, so no real secret has to live in
 * the deployment manifest or image. A JSON object in AWS Secrets Manager (`SECRETS_MANAGER_SECRET_ID`), keys = env var names
 * (e.g. JWT_SECRET, JWT_SECRET_PREVIOUS, DATA_ENC_KEY, ...). Vault values win over plain env so a stale manifest value cannot shadow a rotation.
 * Fails closed: if a secret id is configured and cannot be read, the process does not start.
 */
export async function loadSecrets(env: NodeJS.ProcessEnv = process.env, client?: { send(c: any): Promise<any> }): Promise<string[]> {
  const id = env.SECRETS_MANAGER_SECRET_ID;
  if (!id) return [];
  const c = client ?? new SecretsManagerClient({ region: env.AWS_REGION ?? env.S3_REGION ?? 'ap-south-1' });
  let raw: string | undefined;
  try { raw = (await c.send(new GetSecretValueCommand({ SecretId: id }))).SecretString; }
  catch (e: any) { throw new Error(`cannot read secret store entry (${id}): ${e?.name ?? e?.message ?? e}`); }
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(raw ?? ''); } catch { throw new Error(`secret store entry ${id} is not a JSON object`); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`secret store entry ${id} is not a JSON object`);
  const applied: string[] = [];
  for (const [k, v] of Object.entries(obj)) { if (/^[A-Z][A-Z0-9_]*$/.test(k) && typeof v === 'string' && v) { env[k] = v; applied.push(k); } }
  return applied; // names only, never values
}
