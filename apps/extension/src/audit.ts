/**
 * A log of everything Artemis did in this browser, kept for the user.
 *
 * Issue #436 asks for "a local log of every action (site, verb, time,
 * conversation) the user can read", and the emphasis is on *local*: this is not
 * telemetry and it never leaves the machine. It exists so that the answer to
 * "what did it do while I was away" is a list rather than a recollection, which
 * is the only honest answer when the thing being driven is a browser full of
 * live sessions.
 *
 * A thousand entries, oldest dropped. That is roughly a heavy week and it is
 * bounded because `chrome.storage.local` has a quota and an unbounded log is a
 * slow way to hit it.
 *
 * A refusal is logged as loudly as an action, and deliberately: the interesting
 * rows are the ones where the agent tried a bank, not the ones where it read a
 * page. The `host` is recorded rather than the whole address — a URL carries
 * search terms, document names and sometimes a token, and a log the user leaves
 * open on a second monitor should not be the place those turn up.
 */

/** How many actions the log remembers. */
export const AUDIT_LIMIT = 1_000;

/** One thing Artemis did, or was refused. */
export interface AuditEntry {
  /** Milliseconds since the epoch. */
  readonly at: number;
  /** The conversation, as Artemis names it. */
  readonly runKey: string;
  readonly verb: string;
  /** The host the page was on, `—` when there was no page. Never the full URL. */
  readonly host: string;
  readonly outcome: 'ok' | 'refused';
  /** Present on a refusal: the sentence the agent was given. */
  readonly reason?: string;
}

/**
 * The log with one more entry on the end, dropping the oldest at the ceiling.
 *
 * A new array rather than a mutation, so the caller writes the result to
 * storage and there is no in-memory copy to fall out of step with it. The log
 * is written once per verb, which is not a rate worth optimising for.
 */
export function appendAudit(log: readonly AuditEntry[], entry: AuditEntry, limit: number = AUDIT_LIMIT): readonly AuditEntry[] {
  const next = [...log, entry];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** The host of an address, for the log. `—` when there is nothing to name. */
export function auditHost(url: string | null): string {
  if (url === null || url.length === 0) return '—';
  const match = /^[a-z][a-z0-9+.-]*:(?:\/\/)?(?:[^@/?#]*@)?([^/?#:]*)/iu.exec(url.trim());
  const host = match === null ? '' : (match[1] as string).toLowerCase();
  return host.length === 0 ? url.slice(0, 64) : host;
}

/** Entries read back out of storage, with anything malformed dropped. */
export function auditFromStorage(value: unknown): readonly AuditEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is AuditEntry =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as AuditEntry).at === 'number' &&
      typeof (entry as AuditEntry).verb === 'string' &&
      typeof (entry as AuditEntry).host === 'string',
  );
}
