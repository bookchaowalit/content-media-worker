/**
 * Transcript error rates for provider evaluation.
 *
 * Thai has no spaces between words, so word error rate depends on whichever
 * word segmenter produced the tokens. Thai is therefore scored by character
 * error rate (CER); English by word error rate (WER). Both are edit distance
 * over normalized tokens divided by the reference length.
 */

const PUNCT = /[\p{P}\p{S}]/gu;

export type ErrorMetric = 'cer' | 'wer';

export function metricFor(language: string): ErrorMetric {
  return language === 'en' ? 'wer' : 'cer';
}

export function normalizeForScoring(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(PUNCT, ' ').replace(/\s+/g, ' ').trim();
}

export function tokens(text: string, metric: ErrorMetric): string[] {
  const normalized = normalizeForScoring(text);
  if (!normalized) return [];
  // CER ignores spaces: a provider that inserts or drops Thai word spaces is not penalized.
  return metric === 'wer' ? normalized.split(' ') : [...normalized.replace(/ /g, '')];
}

export function editDistance(reference: string[], hypothesis: string[]): number {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let i = 1; i <= reference.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= hypothesis.length; j += 1) {
      const substitution = previous[j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[hypothesis.length];
}

/** Error rate in percent, rounded to two decimals. */
export function errorRatePct(reference: string, hypothesis: string, metric: ErrorMetric): number {
  const ref = tokens(reference, metric);
  const hyp = tokens(hypothesis, metric);
  if (!ref.length) return hyp.length ? 100 : 0;
  return Math.round((editDistance(ref, hyp) / ref.length) * 10_000) / 100;
}
