import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { currentTrace } from './trace';

/** Remove personal data from anything that is logged: emails, Indian mobiles, Aadhaar-/PAN-shaped numbers, bearer tokens. */
export function redact(s: string): string {
  return s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]').replace(/(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g, '[phone]').replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '[id]')
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[id]').replace(/Bearer\s+[\w.-]+/gi, 'Bearer [token]').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]');
}

/** One JSON object per line (ingestible by any log pipeline). Messages are redacted; request/response bodies are never logged. */
export class JsonLogger extends ConsoleLogger {
  private emit(level: string, message: unknown, ctx?: string) {
    const msg = typeof message === 'string' ? message : (() => { try { return JSON.stringify(message); } catch { return String(message); } })();
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, ctx, traceId: currentTrace()?.traceId, msg: redact(msg) }) + '\n');
  }
  log(m: any, ctx?: string) { this.emit('info', m, ctx); }
  warn(m: any, ctx?: string) { this.emit('warn', m, ctx); }
  error(m: any, stack?: string, ctx?: string) { this.emit('error', m, ctx); if (stack) this.emit('error', String(stack).split('\n').slice(0, 5).join(' | '), ctx); }
  debug(m: any, ctx?: string) { if (process.env.LOG_LEVEL === 'debug') this.emit('debug', m, ctx); }
  verbose() { /* off */ }
  setLogLevels(_l: LogLevel[]) { /* fixed */ }
}

export function accessLog(rec: { method: string; route: string; status: number; ms: number; cid: string; traceId?: string; actor?: string; ip?: string }) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level: 'info', ctx: 'http', ...rec }) + '\n');
}
