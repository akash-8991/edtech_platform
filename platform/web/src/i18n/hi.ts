import hi from './hi.json';
/** Hindi strings, keyed by the English source text. Add the English text to hi.json whenever you add a t('…') call: a test checks every one. */
export const HI = hi as Record<string, string>;
