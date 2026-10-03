// Content accessibility readiness (WCAG 2.2 AA applies to the client apps; this is what the platform can enforce on the CONTENT it serves).
export interface A11yTopic { title: string; mandatory: boolean; assets: { kind: string; language: string; files: any; interactions: any }[] }
export interface A11yIssue { topic: string; language?: string; severity: 'BLOCKING' | 'ADVISORY'; rule: string; message: string }

export const accessibilityEnforced = () => process.env.ACCESSIBILITY_ENFORCE === '1' || (process.env.NODE_ENV === 'production' && process.env.ACCESSIBILITY_ENFORCE !== '0');

/**
 * Blocking: a transcript for every video (deaf/hard-of-hearing learners, search, low bandwidth) and a text alternative for every
 * interaction (screen-reader users). Advisory: audio-only rendition (low bandwidth, blind learners) and a low-bandwidth video rendition.
 */
export function accessibilityReport(topics: A11yTopic[], languages: string[]): A11yIssue[] {
  const out: A11yIssue[] = [];
  for (const t of topics) {
    if (!t.mandatory) continue;
    const vids = t.assets.filter((a) => a.kind === 'VIDEO' && a.files?.master);
    for (const l of languages) {
      const v = vids.find((a) => a.language === l); if (!v) continue; // a missing language track is already a readiness error
      if (!v.files?.transcript) out.push({ topic: t.title, language: l, severity: 'BLOCKING', rule: 'transcript', message: `${l} video has no transcript` });
      if (!v.files?.captions) out.push({ topic: t.title, language: l, severity: 'ADVISORY', rule: 'captions', message: `${l} video has no synchronised captions (WebVTT): the transcript alone does not meet WCAG 1.2.2 for deaf and hard-of-hearing learners` });
      if (!v.files?.audio) out.push({ topic: t.title, language: l, severity: 'ADVISORY', rule: 'audio_only', message: `${l} video has no audio-only rendition` });
      if (!v.files?.['360p']) out.push({ topic: t.title, language: l, severity: 'ADVISORY', rule: 'low_bandwidth', message: `${l} video has no low-bandwidth rendition` });
      for (const ix of (Array.isArray(v.interactions) ? v.interactions : []) as any[]) if (!String(ix?.prompt ?? '').trim()) out.push({ topic: t.title, language: l, severity: 'BLOCKING', rule: 'interaction_text', message: `interaction ${ix?.id ?? '?'} has no text alternative` });
    }
  }
  return out;
}
