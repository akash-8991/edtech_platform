const WEAK = /^(change-me|dev-only|secret|password|test|0{16,}|x+)/i;
/** Refuse to start in production with missing or placeholder secrets. Pure so it is unit-tested. */
export function productionConfigProblems(env: NodeJS.ProcessEnv): string[] {
  const p: string[] = [];
  const need = (k: string, min = 32) => { const v = env[k]; if (!v) p.push(`${k} is not set`); else if (WEAK.test(v)) p.push(`${k} looks like a placeholder`); else if (v.length < min) p.push(`${k} must be at least ${min} characters`); };
  need('DATABASE_URL', 10); need('JWT_SECRET'); need('ADMISSIONS_HMAC_SECRET'); need('MEDIA_TOKEN_SECRET'); need('EXAM_RECEIPT_SECRET'); need('LAB_QR_SECRET'); need('METRICS_TOKEN', 24);
  if (!/^[0-9a-f]{64}$/i.test(env.DATA_ENC_KEY ?? '') || /^(.)\1{63}$/i.test(env.DATA_ENC_KEY ?? '')) p.push('DATA_ENC_KEY must be 64 hex characters of real key material (use KMS in production)');
  if (!/^[0-9a-f]{64}$/i.test(env.OFFLINE_MASTER_KEY ?? '') || /^(.)\1{63}$/i.test(env.OFFLINE_MASTER_KEY ?? '')) p.push('OFFLINE_MASTER_KEY must be 64 hex characters of real key material (use KMS in production)');
  if (env.PROCTOR_BASE_URL) { need('PROCTOR_API_KEY', 16); need('PROCTOR_WEBHOOK_SECRET', 24); }
  // Horizontal-scale prerequisites: shared state, durable storage, a real scanner, and web/worker separation.
  if (!env.REDIS_URL) p.push('REDIS_URL is required (shared rate limits and session revocation across instances)');
  if (env.STORAGE_DRIVER !== 's3') p.push('STORAGE_DRIVER must be s3 (local disk is lost on container replacement and not shared between instances)');
  else { if (!env.S3_BUCKET) p.push('S3_BUCKET is not set'); if (!env.S3_ENDPOINT && !env.S3_KMS_KEY_ID) p.push('S3_KMS_KEY_ID is required for SSE-KMS (omit only for an S3-compatible endpoint)'); }
  if (env.SCANNER !== 'clamav') p.push('SCANNER must be clamav (the no-op scanner marks every upload clean)');
  else if (!env.CLAMD_HOST) p.push('CLAMD_HOST is not set');
  if (env.PROCESS_ROLE !== 'api' && env.PROCESS_ROLE !== 'worker') p.push('PROCESS_ROLE must be api or worker (run them as separate deployments)');
  if (env.MFA_ENFORCE === '0') p.push('MFA_ENFORCE=0 is not allowed in production');
  if (env.RATE_LIMIT_DISABLED === '1') p.push('RATE_LIMIT_DISABLED=1 is not allowed in production');
  if (!env.CORS_ORIGINS && !env.CORS_NONE) p.push('set CORS_ORIGINS (or CORS_NONE=1 if no browser origin calls this API)');
  if (env.SANDBOX_MODE === 'docker' && !env.SANDBOX_IMAGE_PYTHON) p.push('SANDBOX_IMAGE_PYTHON must be pinned when the sandbox is enabled');
  return p;
}
