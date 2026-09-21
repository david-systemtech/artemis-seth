/**
 * Turning CDP events into the contract's console and network entries.
 * ============================================================================
 *
 * Three CDP domains report things a developer would open DevTools for, and they
 * disagree about almost everything — the level names, the timestamp units,
 * whether the text is there or has to be assembled from a `RemoteObject` per
 * argument. This file is where that is reconciled, and it is pure so that the
 * reconciliation can be tested against real payloads rather than against a
 * browser.
 *
 * ## Console
 *
 * `Runtime.consoleAPICalled` is what the page's own `console.*` produced.
 * `Runtime.exceptionThrown` is an error nobody caught — the thing a developer
 * most wants and the thing a screenshot cannot show. `Log.entryAdded` is the
 * browser talking about the page rather than the page talking: a request that
 * failed, a deprecation, a CSP violation. All three become one list, because
 * "the console" is what a person sees in one pane.
 *
 * ## Network
 *
 * A request is four events (sent, response, finished *or* failed), so it is
 * assembled in a ledger keyed by CDP's `requestId` and mutated as the rest
 * arrives. The entry is put in the log at `requestWillBeSent`, in the order the
 * page made the requests, and filled in afterwards — the alternative, holding
 * requests back until they complete, loses exactly the requests an agent is
 * usually asking about, the ones that never came back.
 *
 * CDP timestamps are seconds as a float, and both the console's and the
 * network's are `MonotonicTime`, which has no relation to the wall clock. The
 * contract wants milliseconds since the epoch, so the caller's `now` is used
 * for `at` and the monotonic values are only ever subtracted from each other,
 * for `durationMs`.
 */

import type { ConsoleEntry, NetworkEntry } from '@rx-artemis/protocol';

import { BoundedLog } from './buffer.js';

/** Longest single console line kept. A page can log a megabyte of JSON. */
const MAX_CONSOLE_TEXT = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function clip(text: string): string {
  return text.length > MAX_CONSOLE_TEXT ? `${text.slice(0, MAX_CONSOLE_TEXT)}…` : text;
}

/**
 * One `console.log` argument as text.
 *
 * `Runtime.enable` reports arguments as `RemoteObject`s: a primitive carries
 * its `value`, an object carries a `description` like `Object` and, when the
 * browser bothered, a `preview` with the first few properties. The preview is
 * used where it exists because `[object Object]` is the least useful string in
 * software, and the description is the fallback.
 */
export function describeRemoteObject(value: unknown): string {
  if (!isRecord(value)) return String(value);
  if (value['type'] === 'string') return String(value['value'] ?? '');
  if ('value' in value && value['value'] !== undefined) {
    try {
      return typeof value['value'] === 'object' ? JSON.stringify(value['value']) : String(value['value']);
    } catch {
      return String(value['value']);
    }
  }
  const preview = value['preview'];
  if (isRecord(preview) && Array.isArray(preview['properties'])) {
    const parts = (preview['properties'] as unknown[])
      .filter(isRecord)
      .map((property) => `${String(property['name'])}: ${String(property['value'])}`);
    const tail = preview['overflow'] === true ? ', …' : '';
    return `{ ${parts.join(', ')}${tail} }`;
  }
  return String(value['description'] ?? value['className'] ?? value['type'] ?? 'undefined');
}

/** CDP's console types, as the contract's five levels plus `exception`. */
function levelOfConsoleType(type: unknown): ConsoleEntry['level'] {
  switch (type) {
    case 'warning':
      return 'warn';
    case 'error':
    case 'assert':
      return 'error';
    case 'debug':
    case 'trace':
      return 'debug';
    case 'info':
      return 'info';
    default:
      return 'log';
  }
}

/** Where a line came from, when the browser said. */
function sourceOf(frame: unknown): string | undefined {
  if (!isRecord(frame)) return undefined;
  const url = frame['url'];
  if (typeof url !== 'string' || url.length === 0) return undefined;
  const line = frame['lineNumber'];
  return typeof line === 'number' ? `${url}:${String(line + 1)}` : url;
}

/**
 * One console entry from one CDP event, or `null` when the event is not one.
 *
 * `at` is passed in rather than read from a clock so the tests are not about
 * timing, and because CDP's own timestamp is monotonic and would be meaningless
 * to whoever reads the transcript.
 */
export function consoleEntryFor(method: string, params: unknown, at: number): ConsoleEntry | null {
  if (!isRecord(params)) return null;

  if (method === 'Runtime.consoleAPICalled') {
    const args = Array.isArray(params['args']) ? (params['args'] as unknown[]) : [];
    const stack = isRecord(params['stackTrace']) ? (params['stackTrace']['callFrames'] as unknown[] | undefined) : undefined;
    const source = sourceOf(stack?.[0]);
    return {
      level: levelOfConsoleType(params['type']),
      text: clip(args.map(describeRemoteObject).join(' ')),
      at,
      ...(source === undefined ? {} : { source }),
    };
  }

  if (method === 'Runtime.exceptionThrown') {
    const details = isRecord(params['exceptionDetails']) ? params['exceptionDetails'] : {};
    const thrown = details['exception'];
    // `exception.description` is the stack-bearing "Error: boom\n at …" string
    // and is what a developer would read; `text` is CDP's own wrapper, usually
    // "Uncaught (in promise)", which is only useful when there is no exception
    // object at all — a `throw 'a string'`, or a rejected promise with a
    // non-Error reason.
    const described = isRecord(thrown) ? String(thrown['description'] ?? describeRemoteObject(thrown)) : undefined;
    const source = sourceOf(details);
    return {
      level: 'exception',
      text: clip(described ?? String(details['text'] ?? 'Uncaught exception')),
      at,
      ...(source === undefined ? {} : { source }),
    };
  }

  if (method === 'Log.entryAdded') {
    const entry = isRecord(params['entry']) ? params['entry'] : null;
    if (entry === null) return null;
    const level = entry['level'];
    const source = typeof entry['url'] === 'string' && entry['url'].length > 0 ? String(entry['url']) : undefined;
    return {
      level: level === 'error' ? 'error' : level === 'warning' ? 'warn' : level === 'verbose' ? 'debug' : 'info',
      text: clip(String(entry['text'] ?? '')),
      at,
      ...(source === undefined ? {} : { source }),
    };
  }

  return null;
}

/** A network entry being assembled: the contract's shape, still mutable. */
interface PendingRequest {
  method: string;
  url: string;
  status?: number;
  resourceType?: string;
  durationMs?: number;
  failure?: string;
  at: number;
  /** CDP's monotonic clock at `requestWillBeSent`, for the duration. */
  startedAt: number;
}

/**
 * One tab's requests, assembled from the four events that describe each one.
 *
 * The ledger owns the log rather than the other way round because the
 * in-flight map has to be pruned when an entry falls off the end of a bounded
 * log — otherwise a page that polls forever leaks one map entry per request for
 * as long as the tab is open.
 */
export class NetworkLedger {
  readonly #log: BoundedLog<PendingRequest>;
  readonly #inFlight = new Map<string, PendingRequest>();

  constructor(log: BoundedLog<PendingRequest> = new BoundedLog<PendingRequest>()) {
    this.#log = log;
  }

  /** Feed one `Network.*` event. Anything else is ignored. */
  observe(method: string, params: unknown, at: number): void {
    if (!isRecord(params)) return;
    const requestId = typeof params['requestId'] === 'string' ? params['requestId'] : null;
    if (requestId === null) return;
    const timestamp = typeof params['timestamp'] === 'number' ? params['timestamp'] : 0;

    switch (method) {
      case 'Network.requestWillBeSent': {
        const request = isRecord(params['request']) ? params['request'] : {};
        const type = params['type'];
        const pending: PendingRequest = {
          method: String(request['method'] ?? 'GET'),
          url: String(request['url'] ?? ''),
          at,
          startedAt: timestamp,
          ...(typeof type === 'string' ? { resourceType: type } : {}),
        };
        this.#inFlight.set(requestId, pending);
        this.#log.push(pending);
        this.#prune();
        return;
      }
      case 'Network.responseReceived': {
        const pending = this.#inFlight.get(requestId);
        if (pending === undefined) return;
        const response = isRecord(params['response']) ? params['response'] : {};
        if (typeof response['status'] === 'number') pending.status = response['status'];
        if (typeof params['type'] === 'string') pending.resourceType = params['type'];
        return;
      }
      case 'Network.loadingFinished': {
        const pending = this.#inFlight.get(requestId);
        if (pending === undefined) return;
        pending.durationMs = Math.max(0, Math.round((timestamp - pending.startedAt) * 1000));
        this.#inFlight.delete(requestId);
        return;
      }
      case 'Network.loadingFailed': {
        const pending = this.#inFlight.get(requestId);
        if (pending === undefined) return;
        pending.durationMs = Math.max(0, Math.round((timestamp - pending.startedAt) * 1000));
        pending.failure = String(params['errorText'] ?? (params['canceled'] === true ? 'canceled' : 'failed'));
        this.#inFlight.delete(requestId);
        return;
      }
      default:
        return;
    }
  }

  /**
   * The requests since the last drain, and how many were lost to the ceiling.
   *
   * `failedOnly` is applied after the drain, not before: a call that asks only
   * for failures still consumes the successes, so a later plain `network()`
   * does not replay requests the agent has already been told about.
   */
  drain(failedOnly: boolean): { readonly entries: readonly NetworkEntry[]; readonly dropped: number } {
    const { entries, dropped } = this.#log.drain();
    const kept = failedOnly
      ? entries.filter((entry) => entry.failure !== undefined || (entry.status !== undefined && entry.status >= 400))
      : entries;
    return { entries: kept.map(frozen), dropped };
  }

  /** Forget in-flight requests whose entry has already fallen out of the log. */
  #prune(): void {
    if (this.#inFlight.size <= this.#log.size + 64) return;
    const alive = new Set(this.#log.peek());
    for (const [id, pending] of this.#inFlight) if (!alive.has(pending)) this.#inFlight.delete(id);
  }
}

/** A pending request as the contract's read-only entry. */
function frozen(pending: PendingRequest): NetworkEntry {
  return {
    method: pending.method,
    url: pending.url,
    at: pending.at,
    ...(pending.status === undefined ? {} : { status: pending.status }),
    ...(pending.resourceType === undefined ? {} : { resourceType: pending.resourceType }),
    ...(pending.durationMs === undefined ? {} : { durationMs: pending.durationMs }),
    ...(pending.failure === undefined ? {} : { failure: pending.failure }),
  };
}
