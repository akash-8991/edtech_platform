import { randomBytes, generateKeyPairSync, privateDecrypt, constants } from 'crypto';
import { acceptHeartbeat, attemptsRemaining, coverage, gradeQuiz, mergeRanges, topicComplete, unlockedSet, videoComplete } from './progression';
import { decryptBuffer, encryptBuffer, signToken, unwrapWithMaster, verifyToken, wrapForDevice, wrapWithMaster } from './media-crypto';

describe('video engagement', () => {
  it('merges ranges and computes coverage', () => {
    expect(mergeRanges([[0, 10], [10.2, 20], [30, 40]])).toEqual([[0, 20], [30, 40]]);
    expect(coverage([[0, 30], [20, 50]], 100)).toBe(0.5);
  });
  it('rejects implausible heartbeats (seek-to-end cheat)', () => {
    expect(acceptHeartbeat(0, 600, 600)).toBeNull();
    expect(acceptHeartbeat(10, 25, 600)).toEqual([10, 25]);
    expect(acceptHeartbeat(595, 620, 600)).toEqual([595, 600]);
    expect(acceptHeartbeat(700, 710, 600)).toBeNull();
    expect(acceptHeartbeat(NaN, 5, 600)).toBeNull();
  });
  it('passive playback alone is not completion when interactions are required', () => {
    const ix = [{ id: 'q1', atSec: 30, kind: 'pause_quiz', required: true }];
    expect(videoComplete([[0, 100]], 100, ix, [])).toBe(false);
    expect(videoComplete([[0, 100]], 100, ix, ['q1'])).toBe(true);
    expect(videoComplete([[0, 50]], 100, ix, ['q1'])).toBe(false);
  });
});

describe('quiz grading', () => {
  const qs: any[] = [
    { id: 'a', type: 'MCQ_SINGLE', answer: 1, tolerance: 0, points: 2 },
    { id: 'b', type: 'MCQ_MULTI', answer: [0, 2], tolerance: 0, points: 1 },
    { id: 'c', type: 'NUMERIC', answer: 3.14, tolerance: 0.01, points: 1 },
  ];
  it('grades each type and totals by points', () => {
    expect(gradeQuiz(qs, { a: 1, b: [2, 0], c: 3.145 }).scorePercent).toBe(100);
    expect(gradeQuiz(qs, { a: 1, b: [0], c: 'x' }).scorePercent).toBe(50);
    expect(gradeQuiz(qs, {}).scorePercent).toBe(0);
  });
  it('attempt budget includes overrides', () => { expect(attemptsRemaining(3, 3, 0)).toBe(0); expect(attemptsRemaining(3, 3, 2)).toBe(2); });
});

describe('gating', () => {
  const t = (id: string, complete = false, mandatory = true, overrideUnlocked = false) => ({ topicId: id, mandatory, complete, overrideUnlocked });
  it('sequential unlock', () => {
    expect([...unlockedSet([t('1'), t('2'), t('3')])]).toEqual(['1']);
    expect([...unlockedSet([t('1', true), t('2'), t('3')])]).toEqual(['1', '2']);
  });
  it('override unlocks one topic without completing the previous', () => {
    expect([...unlockedSet([t('1'), t('2', false, true, true), t('3')])]).toEqual(['1', '2']);
  });
  it('optional topics do not block', () => {
    expect([...unlockedSet([t('1', true), t('2', false, false), t('3')])]).toEqual(['1', '2', '3']);
  });
  it('topic needs video + quiz + assignment', () => {
    const has = { quiz: true, assignment: true };
    expect(topicComplete({ videoDone: true, quizPassed: true, assignmentSubmitted: false }, has)).toBe(false);
    expect(topicComplete({ videoDone: true, quizPassed: true, assignmentSubmitted: true }, has)).toBe(true);
  });
});

describe('media crypto', () => {
  it('signed tokens expire and resist tampering', () => {
    const t = signToken('s', { k: 'x', exp: Date.now() + 1000 });
    expect(verifyToken('s', t)?.k).toBe('x');
    expect(verifyToken('other', t)).toBeNull();
    expect(verifyToken('s', t, Date.now() + 5000)).toBeNull();
    expect(verifyToken('s', t.replace(/^./, 'A'))).toBeNull();
  });
  it('offline package is device-bound: only the device private key recovers the content', () => {
    const master = randomBytes(32), plain = Buffer.from('lesson video bytes');
    const enc = encryptBuffer(plain);
    const stored = wrapWithMaster(master, enc.key);
    const dev = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const lic = wrapForDevice(dev.publicKey.export({ type: 'spki', format: 'pem' }) as string, unwrapWithMaster(master, stored));
    const k = privateDecrypt({ key: dev.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(lic, 'base64'));
    expect(decryptBuffer(enc.data, k, enc.iv, enc.tag).equals(plain)).toBe(true);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => privateDecrypt({ key: other.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(lic, 'base64'))).toThrow();
    const bad = Buffer.from(enc.data); bad[0] ^= 1;
    expect(() => decryptBuffer(bad, k, enc.iv, enc.tag)).toThrow();
  });
});
