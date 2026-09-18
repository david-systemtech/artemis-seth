/**
 * Finding entries in a bank by what they are about.
 *
 * Plain term matching over words, ranked: a term in the name counts most, then
 * the description (which is written as a retrieval hook), then the scope
 * labels, then the body. A term of four letters or more also matches the start
 * of a longer word — `crawl` finds `crawlers` — while a short term has to match
 * a whole word, so `at` does not find every `path`. No index, no embeddings: a
 * bank is a few hundred small files and reading them is faster than
 * maintaining anything cleverer, and the answer has to be right for a name the
 * agent half-remembers as much as for a topic.
 */

import type { Bank, BankEntry } from './model.js';

export interface SearchHit {
  readonly slug: string;
  readonly entry: BankEntry;
  readonly score: number;
  /** A line or two around the first body match, or the description. */
  readonly snippet: string;
}

/** The shortest term that may match by prefix rather than whole word. */
const PREFIX_FROM = 4;

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 0);
}

function terms(query: string): string[] {
  return [...new Set(words(query).filter((term) => term.length >= 2))];
}

function matches(word: string, term: string): boolean {
  return word === term || (term.length >= PREFIX_FROM && word.startsWith(term));
}

function count(haystack: readonly string[], term: string): number {
  let n = 0;
  for (const word of haystack) if (matches(word, term)) n += 1;
  return n;
}

function snippetFor(entry: BankEntry, needles: readonly string[]): string {
  const lines = entry.body.split('\n');
  for (const line of lines) {
    const here = words(line);
    if (needles.some((needle) => here.some((word) => matches(word, needle)))) {
      return line.trim().slice(0, 240);
    }
  }
  return entry.description;
}

/** Score one entry against the query's terms. Zero means no term matched. */
export function scoreEntry(entry: BankEntry, query: string): number {
  const needles = terms(query);
  if (needles.length === 0) return 0;
  const name = words(entry.name);
  const description = words(entry.description);
  const scope = words(Object.values(entry.scope).join(' '));
  const body = words(entry.body);
  let score = 0;
  let matched = 0;
  for (const needle of needles) {
    let here = 0;
    here += count(name, needle) * 6;
    here += count(description, needle) * 3;
    here += count(scope, needle) * 3;
    here += Math.min(count(body, needle), 5);
    if (here > 0) matched += 1;
    score += here;
  }
  // Every term matching beats one term matching many times.
  return score * (1 + matched / needles.length);
}

/** The best entries across the banks, highest first. */
export function searchBanks(
  banks: readonly { readonly slug: string; readonly bank: Bank }[],
  query: string,
  limit = 8,
): SearchHit[] {
  const needles = terms(query);
  const hits: SearchHit[] = [];
  for (const { slug, bank } of banks) {
    for (const entry of bank.entries) {
      if (entry.problems.length > 0) continue;
      const score = scoreEntry(entry, query);
      if (score <= 0) continue;
      hits.push({ slug, entry, score, snippet: snippetFor(entry, needles) });
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name)).slice(0, Math.max(1, limit));
}
