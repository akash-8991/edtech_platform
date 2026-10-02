import { buildIndex, cosine, groundedness, isGradedQuestion, search, tokenize } from './retrieval';
import { inWorkingHours, priorityFor, rank, slaDueAt, TeacherView } from '../domain/routing';

const chunks = [
  { id: 'c1', title: 'Sensors', text: 'A thermistor is a sensor whose resistance changes with temperature.' },
  { id: 'c2', title: 'Actuators', text: 'A motor is an actuator that converts electrical energy into motion.' },
  { id: 'c3', title: 'हिंदी', text: 'थर्मिस्टर एक सेंसर है जिसका प्रतिरोध तापमान के साथ बदलता है।' },
  { id: 'c4', title: 'Networks', text: 'MQTT is a lightweight publish subscribe protocol for IoT devices.' },
];
const ix = buildIndex(chunks);

describe('retrieval', () => {
  it('ranks the relevant chunk first and reports interpretable coverage', () => {
    const h = search(ix, 'how does a thermistor respond to temperature', 3);
    expect(h[0].id).toBe('c1'); expect(h[0].lexical).toBeGreaterThan(0.5);
  });
  it('unrelated questions score below any sensible threshold (no-answer path)', () => {
    const h = search(ix, 'what is the capital of france', 3);
    expect(h.length === 0 || h[0].score < 0.2).toBe(true);
  });
  it('natural questions with filler words still clear a 0.4 threshold; out-of-domain ones do not', () => {
    const nat = search(ix, 'Can you please explain how resistance changes in a thermistor when it heats up and why?', 3);
    expect(nat[0].id).toBe('c1'); expect(nat[0].score).toBeGreaterThanOrEqual(0.4);
    expect(search(ix, 'please explain the capital of france and its history', 3)).toEqual([]);
    expect((search(ix, 'How much does a thermistor cost to buy?', 1)[0]?.score ?? 0)).toBeLessThan(0.7); // partial matches are damped
  });
  it('handles Devanagari tokens including combining marks', () => {
    expect(tokenize('थर्मिस्टर सेंसर')).toEqual(['थर्मिस्टर', 'सेंसर']);
    expect(search(ix, 'थर्मिस्टर तापमान', 2)[0].id).toBe('c3');
  });
  it('strict filtering: disallowed chunks can never be returned', () => {
    const h = search(ix, 'thermistor temperature', 5, { allow: (c) => c.id !== 'c1' && c.id !== 'c3' });
    expect(h.map((x) => x.id)).not.toContain('c1'); expect(h.map((x) => x.id)).not.toContain('c3');
  });
  it('hybrid: embeddings lift cross-language matches that lexical search cannot see', () => {
    const e = buildIndex([{ ...chunks[2], embedding: [1, 0, 0] }, { ...chunks[1], embedding: [0, 1, 0] }]);
    const h = search(e, 'thermistor temperature resistance', 2, { queryEmbedding: [0.9, 0.1, 0] });
    expect(h[0].id).toBe('c3'); expect(h[0].semantic).toBeGreaterThan(0.9); expect(cosine([1, 0], [0, 1])).toBe(0);
  });
});

describe('grounding guards', () => {
  it('groundedness is high for faithful answers and low for invented ones', () => {
    const src = [chunks[0].text];
    expect(groundedness('A thermistor changes resistance with temperature.', src)).toBeGreaterThan(0.8);
    expect(groundedness('Quantum entanglement powers every modern gyroscope.', src)).toBeLessThan(0.2);
  });
  it('detects pasted graded questions', () => {
    const quiz = ['Which sensor changes resistance with temperature?'];
    expect(isGradedQuestion('Which sensor changes resistance with temperature?', quiz)).toBe(true);
    expect(isGradedQuestion('Can you explain how resistance relates to heat in a thermistor?', quiz)).toBe(false);
    expect(isGradedQuestion('hi', quiz)).toBe(false);
  });
});

describe('teacher routing', () => {
  const T = (o: Partial<TeacherView>): TeacherView => ({ userId: 'a', active: true, available: true, disciplines: ['AI/ML'], skills: [], languages: ['en'], capacity: 10, open: 0, windows: [], ...o });
  const now = new Date('2026-10-05T06:00:00Z'); // Monday 11:30 IST
  const needs = { discipline: 'AI/ML', language: 'en', keywords: [] as string[] };
  it('filters on discipline, availability, capacity, active', () => {
    const r = rank([T({ userId: 'ok' }), T({ userId: 'wrongdisc', disciplines: ['IoT'] }), T({ userId: 'away', available: false }), T({ userId: 'full', open: 10 }), T({ userId: 'off', active: false })], needs, now);
    expect(r.map((x) => x.userId)).toEqual(['ok']);
  });
  it('prefers language match, skills and lower workload', () => {
    const r = rank([T({ userId: 'busy', languages: ['hi', 'en'], open: 8 }), T({ userId: 'free', languages: ['hi', 'en'], open: 1 }), T({ userId: 'skilled', languages: ['hi'], skills: ['pandas'], open: 4 })], { ...needs, language: 'hi', keywords: ['pandas'] }, now);
    expect(r[0].userId).toBe('skilled'); expect(r.map((x) => x.userId)).toEqual(['skilled', 'free', 'busy']);
  });
  it('Hindi learner falls back to an English-speaking teacher with a penalty; no common language = ineligible', () => {
    const r = rank([T({ userId: 'en' }), T({ userId: 'ta', languages: ['ta'] })], { ...needs, language: 'hi' }, now);
    expect(r.map((x) => x.userId)).toEqual(['en']); expect(r[0].reasons.join()).toMatch(/fallback/);
  });
  it('respects IST working windows', () => {
    const w = [{ day: 1, start: '09:00', end: '12:00' }];
    expect(inWorkingHours(w, now)).toBe(true);
    expect(inWorkingHours(w, new Date('2026-10-05T10:00:00Z'))).toBe(false); // 15:30 IST
    expect(rank([T({ windows: w })], needs, new Date('2026-10-05T10:00:00Z'))).toEqual([]);
  });
  it('ties go to the longest-idle teacher', () => {
    const r = rank([T({ userId: 'recent', lastAssignedAt: new Date('2026-10-05T05:00:00Z') }), T({ userId: 'idle', lastAssignedAt: new Date('2026-10-01T00:00:00Z') })], needs, now);
    expect(r[0].userId).toBe('idle');
  });
  it('priority and SLA', () => {
    expect(priorityFor('CONTENT', false)).toBe('P3'); expect(priorityFor('QUIZ', false)).toBe('P2'); expect(priorityFor('CONTENT', true)).toBe('P1'); expect(priorityFor('TECHNICAL', false)).toBe('P1');
    expect(slaDueAt('P1', { P1: 30 }, now).getTime() - now.getTime()).toBe(30 * 60_000);
    expect(slaDueAt('P3', {}, now).getTime() - now.getTime()).toBe(1440 * 60_000);
  });
});
