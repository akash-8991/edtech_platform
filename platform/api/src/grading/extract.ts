import { unzipSync } from 'fflate';

export interface ExtractedFile { name: string; parsed: boolean; bytes: number; note?: string }
export interface Extracted { text: string; files: ExtractedFile[]; codeFiles: { path: string; content: string }[]; truncated: boolean }

const TEXT_EXT = /\.(txt|md|csv|py|js|ts|java|c|cpp|h|json|html|css|sql|yaml|yml|sh|r|ipynb)$/i;
const BINARY_EXT = /\.(pdf|docx?|png|jpe?g|gif|mp3|mp4|wav|zip)$/i;
export const LIMITS = { totalText: 200_000, zipEntries: 200, zipTotal: 5 * 1024 * 1024, zipEntry: 1024 * 1024 };

const isText = (b: Uint8Array) => { const n = Math.min(b.length, 4096); for (let i = 0; i < n; i++) if (b[i] === 0) return false; return true; };
const dec = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: false }).decode(b);

function notebookText(raw: string): string {
  try {
    const nb = JSON.parse(raw);
    return (nb.cells ?? []).map((c: any, i: number) => `# cell ${i + 1} (${c.cell_type})\n${Array.isArray(c.source) ? c.source.join('') : String(c.source ?? '')}`).join('\n\n'); // outputs ignored: not learner-authored evidence
  } catch { return ''; }
}

const safeName = (n: string) => !!n && !n.startsWith('/') && !n.split('/').includes('..') && !n.includes('\0') && !n.startsWith('__MACOSX/');

/** Deterministic text extraction. Anything not parsed is reported as such so a human sees it (never silently ignored). */
export function extractSubmission(text: string, files: { name: string; data: Buffer }[]): Extracted {
  const out: Extracted = { text: '', files: [], codeFiles: [], truncated: false };
  const parts: string[] = [];
  if (text?.trim()) parts.push(`### learner text\n${text.trim()}`);
  const add = (name: string, bytes: number, body: string) => { parts.push(`### file: ${name}\n${body}`); out.files.push({ name, parsed: true, bytes }); if (/\.(py|js|ts|java|c|cpp|h|sql|sh|r)$/i.test(name)) out.codeFiles.push({ path: name, content: body }); };
  const handle = (name: string, data: Uint8Array, depth: number) => {
    if (/\.zip$/i.test(name)) {
      if (depth > 0) { out.files.push({ name, parsed: false, bytes: data.length, note: 'nested archive not opened' }); return; }
      let n = 0, total = 0, skipped = 0;
      try {
        const entries = unzipSync(data, { filter: (f) => { if (f.name.endsWith('/')) return false; n++; total += f.originalSize; if (n > LIMITS.zipEntries || total > LIMITS.zipTotal || f.originalSize > LIMITS.zipEntry || !safeName(f.name)) { skipped++; return false; } return true; } });
        for (const [en, d] of Object.entries(entries)) handle(`${name}!/${en}`, d, depth + 1);
        if (skipped) out.files.push({ name, parsed: true, bytes: data.length, note: `${skipped} archive entries skipped (limits or unsafe path)` });
      } catch { out.files.push({ name, parsed: false, bytes: data.length, note: 'archive unreadable' }); }
      return;
    }
    if (TEXT_EXT.test(name) && isText(data)) { const raw = dec(data); add(name, data.length, /\.ipynb$/i.test(name) ? notebookText(raw) : raw); return; }
    out.files.push({ name, parsed: false, bytes: data.length, note: BINARY_EXT.test(name) ? 'binary/media format is not machine-read' : 'unsupported or binary content' });
  };
  for (const f of files) handle(f.name, f.data, 0);
  let t = parts.join('\n\n');
  if (t.length > LIMITS.totalText) { t = t.slice(0, LIMITS.totalText); out.truncated = true; }
  out.text = t;
  return out;
}
