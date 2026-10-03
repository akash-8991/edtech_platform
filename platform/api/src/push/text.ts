/** What a push says, per notification type and language. Kept in step with the web app's notification text (web/src/lib/format.ts and i18n/hi.json). */
const T: Record<string, { en: string; hi: string }> = {
  'topic.completed': { en: 'You completed a topic.', hi: 'आपने एक विषय पूरा किया।' }, 'exam.registered': { en: 'You are registered for an exam session.', hi: 'आप एक परीक्षा सत्र के लिए पंजीकृत हैं।' },
  'exam.submitted': { en: 'Your exam was submitted.', hi: 'आपकी परीक्षा जमा हो गई।' }, 'exam.result_released': { en: 'Your exam result has been released.', hi: 'आपका परीक्षा परिणाम जारी हो गया है।' },
  'privacy.export_ready': { en: 'Your data download is ready.', hi: 'आपका डेटा डाउनलोड तैयार है।' }, 'privacy.request_decided': { en: 'A decision was made on your privacy request.', hi: 'आपके गोपनीयता अनुरोध पर फ़ैसला हो गया है।' },
  'lab.booked': { en: 'Your lab session is booked.', hi: 'आपका लैब सत्र बुक हो गया है।' }, 'lab.completed': { en: 'You completed a lab.', hi: 'आपने एक लैब पूरी की।' },
  'lab.slot_cancelled': { en: 'A lab session you booked was cancelled. Please book another.', hi: 'आपका बुक किया हुआ एक लैब सत्र रद्द हो गया। कृपया दूसरा बुक करें।' },
  'assignment.graded': { en: 'Your assignment has been graded.', hi: 'आपके असाइनमेंट को ग्रेड मिल गया है।' }, 'assignment.under_review': { en: 'A teacher is reviewing your assignment.', hi: 'एक शिक्षक आपका असाइनमेंट देख रहे हैं।' },
  'assignment.appeal_decided': { en: 'Your grade appeal has been decided.', hi: 'आपकी ग्रेड-अपील पर फ़ैसला हो गया है।' }, 'programme.completed': { en: 'Congratulations, you completed the programme.', hi: 'बधाई हो, आपने प्रोग्राम पूरा कर लिया।' },
  'topic.unlocked': { en: 'A new topic is unlocked.', hi: 'एक नया विषय खुल गया है।' }, 'entitlement.expiring': { en: 'Your access ends soon.', hi: 'आपकी पहुँच जल्द समाप्त होगी।' },
  'doubt.reply': { en: 'A teacher replied to your doubt.', hi: 'एक शिक्षक ने आपके सवाल का जवाब दिया है।' }, 'progression.override': { en: 'Your access to a topic was changed by an administrator.', hi: 'किसी विषय तक आपकी पहुँच प्रशासक ने बदली है।' },
};
const APP = { en: 'Learning Portal', hi: 'लर्निंग पोर्टल' };
export type Lang = 'en' | 'hi';
export const pushable = (type: string) => type in T;

/** Where a tap should go (an in-app path); mirrors the web app's notificationLink. */
export function pushUrl(type: string, payload: any): string {
  if (type.startsWith('lab.')) return '/labs'; if (type.startsWith('privacy.')) return '/privacy';
  if (type.startsWith('assignment.') && typeof payload?.submissionId === 'string') return `/grades/${payload.submissionId}`;
  if (type.startsWith('exam.') && typeof payload?.attemptId === 'string' && type !== 'exam.registered') return `/exam-results/${payload.attemptId}`;
  if (type === 'doubt.reply') return '/doubts'; if (type.startsWith('topic.') || type.startsWith('programme.')) return '/'; return '/notifications';
}
/** null for a type with no learner-facing text: a notification nobody can read is not pushed. */
export function pushMessage(type: string, payload: any, lang: string): { title: string; body: string; url: string; tag: string } | null {
  const row = T[type]; if (!row) return null; const l: Lang = lang === 'hi' ? 'hi' : 'en';
  return { title: APP[l], body: row[l], url: pushUrl(type, payload), tag: type };
}
