/** Helpers for the AI course generator in the staff console. The server validates everything again; this makes the form fail early and in plain words. */
export const AI_GEN = ['CONTENT_AUTHOR', 'ACADEMIC_ADMIN'] as const;

export interface CurriculumForm { code: string; title: string; discipline: string; audience: string; durationType: 'M12' | 'M18'; hours: string; outcomes: string; prerequisites: string; languages: string[]; refTitle: string; refText: string }
export const emptyCurriculum = (): CurriculumForm => ({ code: '', title: '', discipline: '', audience: '', durationType: 'M12', hours: '40', outcomes: '', prerequisites: '', languages: ['en'], refTitle: '', refText: '' });
const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

export function curriculumProblem(f: CurriculumForm): string | null {
  if (!f.code.trim()) return 'Give the programme a short code (for example IOT-101).';
  if (!/^[A-Za-z0-9._-]{2,30}$/.test(f.code.trim())) return 'The code uses letters, numbers, dots, dashes and underscores only (2 to 30 characters).';
  if (!f.title.trim()) return 'Give the programme a title.'; if (!f.discipline.trim()) return 'Say which discipline it belongs to.'; if (!f.audience.trim()) return 'Say who it is for: the AI writes at their level.';
  const h = Number(f.hours); if (!Number.isInteger(h) || h < 1 || h > 5000) return 'Hours must be a whole number from 1 to 5000.';
  if (!lines(f.outcomes).length) return 'Write at least one learning outcome (one per line): everything the AI writes is checked against them.';
  if (!f.languages.includes('en')) return 'English is always included (Hindi is added to it).';
  if (f.refText.trim() && f.refText.length > 400_000) return 'The reference text is too long (400,000 characters at most).';
  return null;
}
export function curriculumBody(f: CurriculumForm) {
  return { programme: { code: f.code.trim(), title: f.title.trim() }, title: f.title.trim(), discipline: f.discipline.trim(), audience: f.audience.trim(), durationType: f.durationType, hours: Number(f.hours), outcomes: lines(f.outcomes), prerequisites: lines(f.prerequisites), languages: f.languages,
    ...(f.refText.trim() && { references: [{ id: 'ref-1', title: f.refTitle.trim() || 'Reference material', text: f.refText.trim() }] }) };
}
export const topicBody = (topicId: string, instruction: string, languages: string[], refText: string) => ({ topicId, ...(instruction.trim() && { instruction: instruction.trim() }), languages, ...(refText.trim() && { references: [{ id: 'ref-1', title: 'Reference material', text: refText.trim() }] }) });
export const topicProblem = (topicId: string, languages: string[], refText: string): string | null => !topicId ? 'Choose the topic.' : !languages.length ? 'Choose at least one language.' : refText.length > 400_000 ? 'The reference text is too long (400,000 characters at most).' : null;

export type JobTone = 'ok' | 'warn' | 'muted';
export const JOB_STATUS: Record<string, { label: string; tone: JobTone }> = { QUEUED: { label: 'Waiting for its turn', tone: 'warn' }, RUNNING: { label: 'Being written', tone: 'warn' }, SUCCEEDED: { label: 'Done', tone: 'ok' }, FAILED: { label: 'Did not work', tone: 'warn' }, CANCELLED: { label: 'Cancelled', tone: 'muted' } };
export const jobLabel = (s: string) => JOB_STATUS[s]?.label ?? s.toLowerCase(); export const jobTone = (s: string): JobTone => JOB_STATUS[s]?.tone ?? 'muted';
export const isFinished = (s: string) => s === 'SUCCEEDED' || s === 'FAILED' || s === 'CANCELLED';
export const kindLabel = (k: string) => ({ CURRICULUM: 'Whole course', TOPIC_CONTENT: 'One topic' } as Record<string, string>)[k] ?? k.toLowerCase().replace(/_/g, ' ');

export interface JobView { id: string; kind: string; status: string; error: string | null; result: any; attempts: number; costUsd: number; versionId: string | null; topicId: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null }

/** Says what to do about a failed job, in plain words. `result` carries the server's reason for a failure. */
export function failureHelp(j: Pick<JobView, 'status' | 'error' | 'result'>): string | null {
  if (j.status !== 'FAILED') return null; const r = j.result ?? {};
  if (r.error === 'ai_disabled') return 'AI generation is switched off by an administrator. Ask a platform administrator to turn it back on (Operations → settings).';
  if (r.error === 'ai_limit') return `The AI limit was reached: ${r.message ?? 'try again later'}. A platform administrator can raise the daily budget.`;
  if (r.error === 'ai_unavailable') { const a: { error?: string }[] = Array.isArray(r.attempts) ? r.attempts : []; return a.length && a.every((x) => x.error === 'not_configured') ? 'No AI provider is set up on the server. A platform administrator must add an ANTHROPIC_API_KEY or OPENROUTER_API_KEY.' : 'The AI services could not be reached or refused the request. Try again in a few minutes; if it keeps failing, tell a platform administrator.'; }
  if (r.code === 'validation_failed') return 'The AI wrote a course that did not pass the checks, even after one repair. Make the outcomes and hours more specific, or add reference material, and try again.';
  if (r.code === 'not_draft') return 'That version is no longer a draft (it is in review or published). Make a new version and generate into that.';
  if (r.code === 'not_found') return 'The topic no longer exists.';
  return 'Something went wrong. You can try again; if it repeats, tell a platform administrator.';
}

/** The command-line steps that turn a generated script into video. Rendering runs on a machine with the video tools, not in the browser. */
export const videoSteps = (origin: string, topicId: string) => [
  `cd platform/video_engine`,
  `python fetch_manifest.py --api ${origin} --token "$TOKEN" --topic-id ${topicId} > topic.json`,
  `python cli.py qa topic.json`,
  `python cli.py build topic.json --out out/ --mock        # drop --mock to render for real (costs money)`,
  `python publish.py topic.json out/ --api ${origin} --token "$TOKEN" --topic-id ${topicId} --abr`,
].join('\n');
