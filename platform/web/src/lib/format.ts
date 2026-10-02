export const fmtTime = (sec: number) => { const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const notificationText = (type: string): string => ({
  'topic.completed': 'You completed a topic.', 'programme.completed': 'Congratulations, you completed the programme.', 'topic.unlocked': 'A new topic is unlocked.', 'entitlement.expiring': 'Your access ends soon.',
  'grade.released': 'A grade has been released.', 'doubt.reply': 'A teacher replied to your doubt.',
} as Record<string, string>)[type] ?? type.replace(/[._]/g, ' ');
export const idempotencyKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^A-Za-z0-9_\-:.]/g, '');
