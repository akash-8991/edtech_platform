// Doubt-centre routing and SLA rules (DCC-001). Pure functions; the service supplies live workload and config.
export interface Window { day: number; start: string; end: string } // day 0=Sunday, times HH:MM in IST
export interface TeacherView {
  userId: string; active: boolean; available: boolean; disciplines: string[]; skills: string[]; languages: string[];
  capacity: number; open: number; lastAssignedAt?: Date | null; windows: Window[];
}
export interface Needs { discipline: string; language: string; keywords: string[]; exclude?: string[] }
export interface Ranked { userId: string; score: number; reasons: string[] }

const IST_MS = 5.5 * 3600_000;
export function inWorkingHours(windows: Window[], now: Date): boolean {
  if (!windows.length) return true;
  const ist = new Date(now.getTime() + IST_MS);
  const hhmm = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const m = (s: string) => { const [h, mm] = s.split(':').map(Number); return h * 60 + mm; };
  return windows.some((w) => w.day === ist.getUTCDay() && hhmm >= m(w.start) && hhmm < m(w.end));
}

const lc = (a: string[]) => a.map((x) => x.toLowerCase());

/** Eligible teachers, best first. Empty list = leave the ticket unassigned for the queue/support. */
export function rank(teachers: TeacherView[], n: Needs, now: Date): Ranked[] {
  const out: Ranked[] = [];
  for (const t of teachers) {
    if (!t.active || !t.available || t.open >= t.capacity || n.exclude?.includes(t.userId)) continue;
    if (!lc(t.disciplines).includes(n.discipline.toLowerCase())) continue;
    if (!inWorkingHours(t.windows, now)) continue;
    const langs = lc(t.languages); const reasons: string[] = []; let score = 100;
    if (langs.includes(n.language)) { score += langs[0] === n.language ? 10 : 5; reasons.push('language match'); }
    else if (langs.includes('en')) { score -= 30; reasons.push('language fallback to English'); } // learner may be served in English if nobody speaks theirs
    else continue;
    const skills = lc(t.skills); const hit = [...new Set(lc(n.keywords))].filter((k) => skills.includes(k));
    if (hit.length) { score += Math.min(40, hit.length * 20); reasons.push(`skills: ${hit.join(',')}`); }
    score -= Math.round(50 * (t.open / t.capacity)); reasons.push(`load ${t.open}/${t.capacity}`);
    out.push({ userId: t.userId, score, reasons });
  }
  const last = new Map(teachers.map((t) => [t.userId, t.lastAssignedAt?.getTime() ?? 0]));
  return out.sort((a, b) => b.score - a.score || (last.get(a.userId)! - last.get(b.userId)!)); // tie: longest-idle first
}

export type Priority = 'P1' | 'P2' | 'P3';
export const DEFAULT_SLA_MINUTES: Record<Priority, number> = { P1: 60, P2: 240, P3: 1440 };

export function priorityFor(category: string, blocked: boolean): Priority {
  if (blocked || category === 'TECHNICAL') return 'P1';
  if (category === 'ASSIGNMENT' || category === 'QUIZ') return 'P2';
  return 'P3';
}
export const slaDueAt = (p: Priority, sla: Record<string, number>, from: Date) => new Date(from.getTime() + (sla[p] ?? DEFAULT_SLA_MINUTES[p]) * 60_000);

export const TICKET_OPEN = ['ASSIGNED', 'IN_PROGRESS', 'WAITING_LEARNER'];
