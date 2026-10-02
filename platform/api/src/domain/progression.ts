// Pure learning rules. All progression decisions are made server-side from these functions.

export type Range = [number, number];

/** Merge overlapping/adjacent watched ranges. */
export function mergeRanges(rs: Range[]): Range[] {
  const s = rs.filter(([a, b]) => b > a).map(([a, b]) => [a, b] as Range).sort((x, y) => x[0] - y[0]);
  const out: Range[] = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 0.5) last[1] = Math.max(last[1], r[1]); else out.push(r);
  }
  return out;
}

export const coverage = (rs: Range[], duration: number): number =>
  duration > 0 ? Math.min(1, mergeRanges(rs).reduce((s, [a, b]) => s + (Math.min(b, duration) - Math.max(a, 0)), 0) / duration) : 0;

export const MAX_HEARTBEAT_SEC = 30; // a heartbeat cannot claim more than 30s of viewing: blocks seek-to-end cheating

/** Validate a client-reported watched range; returns the clamped range or null if implausible. */
export function acceptHeartbeat(from: number, to: number, duration: number): Range | null {
  if (![from, to].every(Number.isFinite) || from < 0 || to <= from || from >= duration) return null;
  if (to - from > MAX_HEARTBEAT_SEC) return null;
  return [from, Math.min(to, duration)];
}

export const VIDEO_COMPLETE_THRESHOLD = 0.9;

export interface Interaction { id: string; atSec: number; kind: string; required?: boolean }

/** Passive playback alone is not mastery: need coverage AND every required interaction answered. */
export function videoComplete(ranges: Range[], duration: number, interactions: Interaction[], responded: string[]): boolean {
  if (coverage(mergeRanges(ranges), duration) < VIDEO_COMPLETE_THRESHOLD) return false;
  return interactions.filter((i) => i.required).every((i) => responded.includes(i.id));
}

// ---- Quiz grading -------------------------------------------------------
export interface Q { id: string; type: 'MCQ_SINGLE' | 'MCQ_MULTI' | 'NUMERIC'; answer: any; tolerance: number; points: number }

export function gradeQuestion(q: Q, given: unknown): boolean {
  switch (q.type) {
    case 'MCQ_SINGLE': return given === q.answer;
    case 'MCQ_MULTI': {
      if (!Array.isArray(given)) return false;
      const a = [...new Set(given as number[])].sort(), b = [...(q.answer as number[])].sort();
      return a.length === b.length && a.every((x, i) => x === b[i]);
    }
    case 'NUMERIC': return typeof given === 'number' && Number.isFinite(given) && Math.abs(given - q.answer) <= q.tolerance;
  }
}

export function gradeQuiz(qs: Q[], answers: Record<string, unknown>) {
  const total = qs.reduce((s, q) => s + q.points, 0);
  const results = qs.map((q) => ({ questionId: q.id, correct: gradeQuestion(q, answers[q.id]), points: q.points }));
  const got = results.filter((r) => r.correct).reduce((s, r) => s + r.points, 0);
  return { scorePercent: total ? Math.round((got / total) * 1000) / 10 : 0, results };
}

/** Attempts allowed = maxAttempts + granted EXTRA_QUIZ_ATTEMPTS overrides. */
export const attemptsRemaining = (max: number, used: number, extra: number) => Math.max(0, max + extra - used);

// ---- Gating ---------------------------------------------------------------
export interface TopicState { topicId: string; mandatory: boolean; complete: boolean; overrideUnlocked: boolean }

/**
 * Strictly sequential: topic i is unlocked iff the nearest earlier MANDATORY topic is complete, or topic i itself
 * carries an UNLOCK_TOPIC override. Optional topics never block.
 */
export function unlockedSet(topics: TopicState[]): Set<string> {
  const out = new Set<string>();
  topics.forEach((t, i) => {
    if (i === 0 || t.overrideUnlocked) { out.add(t.topicId); return; }
    // walk back over non-mandatory topics: they never block
    let j = i - 1;
    while (j >= 0 && !topics[j].mandatory) j--;
    if (j < 0 || topics[j].complete) out.add(t.topicId);
  });
  return out;
}

export const topicComplete = (p: { videoDone: boolean; quizPassed: boolean; assignmentSubmitted: boolean }, has: { quiz: boolean; assignment: boolean }) =>
  p.videoDone && (!has.quiz || p.quizPassed) && (!has.assignment || p.assignmentSubmitted);
