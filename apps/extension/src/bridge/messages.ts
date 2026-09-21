/**
 * Reading what came down the socket, without believing any of it.
 * ============================================================================
 *
 * The other end of this socket is Artemis, and the whole point of the pairing
 * secret is that it usually is. But "usually" is the wrong word to build on:
 * anything on the machine can open the port and start talking before it is
 * challenged, and a compromised Artemis is one of the three adversaries issue
 * #436 names. So every message is parsed into a known shape here and every
 * field the extension acts on is checked, and nothing downstream casts.
 *
 * The parser returns `null` rather than throwing for the same reason the driver
 * refuses rather than throws: the caller is a socket handler, an unreadable
 * frame is an ordinary event, and a service worker that throws out of an
 * `onmessage` takes the connection down with it.
 */

import type { BridgeCall, BridgeFromArtemis, BridgeVerb, PagePolicy } from '@rx-artemis/protocol';

/** The verbs this extension implements, which is all of them. */
const VERBS: readonly BridgeVerb['verb'][] = [
  'open',
  'navigate',
  'read',
  'screenshot',
  'click',
  'type',
  'console',
  'network',
  'cookies',
  'storage',
  'evaluate',
  'close',
];

/**
 * Longest string this will accept in any field of a call.
 *
 * A selector, an expression and a URL are all model output arriving over a
 * socket, and a megabyte of it would be buffered in a service worker with a
 * fixed memory budget. The number is generous for every real use — the longest
 * plausible member is an `evaluate` expression — and the refusal it produces is
 * readable.
 */
const MAX_FIELD = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = MAX_FIELD): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

/** A policy, with every list forced to an array of strings and every flag to a boolean. */
function policyOf(value: unknown): PagePolicy | null {
  if (!isRecord(value)) return null;
  const list = (field: unknown): readonly string[] | null => {
    if (!Array.isArray(field)) return null;
    if (field.length > 1_000) return null;
    return field.every((entry) => typeof entry === 'string' && entry.length <= 255) ? (field as string[]) : null;
  };
  const devSites = list(value['devSites']);
  const blockedSites = list(value['blockedSites']);
  const unblockedSites = list(value['unblockedSites']);
  if (devSites === null || blockedSites === null || unblockedSites === null) return null;
  return {
    devSites,
    blockedSites,
    unblockedSites,
    evaluateEverywhere: value['evaluateEverywhere'] === true,
    deepReadEverywhere: value['deepReadEverywhere'] === true,
  };
}

/** A call, with its verb's own arguments checked. */
function callOf(value: Record<string, unknown>): BridgeCall | null {
  const id = text(value['id'], 256);
  const runKey = text(value['runKey'], 256);
  const verb = value['verb'];
  if (id === null || runKey === null || typeof verb !== 'string') return null;
  if (!VERBS.includes(verb as BridgeVerb['verb'])) return null;
  const head = { type: 'call' as const, id, runKey };

  switch (verb as BridgeVerb['verb']) {
    case 'open': {
      if (value['url'] === undefined) return { ...head, verb: 'open' };
      const url = text(value['url'], 8_192);
      return url === null ? null : { ...head, verb: 'open', url };
    }
    case 'navigate': {
      const url = text(value['url'], 8_192);
      return url === null ? null : { ...head, verb: 'navigate', url };
    }
    case 'click': {
      const selector = text(value['selector'], 4_096);
      return selector === null ? null : { ...head, verb: 'click', selector };
    }
    case 'type': {
      const selector = text(value['selector'], 4_096);
      const typed = text(value['text']);
      return selector === null || typed === null ? null : { ...head, verb: 'type', selector, text: typed };
    }
    case 'network':
      return { ...head, verb: 'network', failedOnly: value['failedOnly'] === true };
    case 'evaluate': {
      const expression = text(value['expression']);
      return expression === null ? null : { ...head, verb: 'evaluate', expression };
    }
    case 'read':
    case 'screenshot':
    case 'console':
    case 'cookies':
    case 'storage':
    case 'close':
      return { ...head, verb: verb as 'read' };
  }
}

/**
 * One frame from Artemis, or `null` if it was not one.
 *
 * Note what is *not* validated: `BridgePaired.secret` and `BridgeChallenge.nonce`
 * are taken as the strings they are. Their contents are Artemis's business —
 * the extension signs the nonce it was given and stores the secret it was
 * given, and a wrong one fails at the next handshake, which is the design.
 */
export function parseFromArtemis(raw: string): BridgeFromArtemis | null {
  if (raw.length > 8 * 1024 * 1024) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  switch (value['type']) {
    case 'paired': {
      const browserId = text(value['browserId'], 256);
      const secret = text(value['secret'], 1_024);
      const policy = policyOf(value['policy']);
      if (browserId === null || secret === null || policy === null) return null;
      return { type: 'paired', browserId, secret, policy };
    }
    case 'challenge': {
      const nonce = text(value['nonce'], 1_024);
      return nonce === null ? null : { type: 'challenge', nonce };
    }
    case 'ready': {
      const policy = policyOf(value['policy']);
      return policy === null ? null : { type: 'ready', policy };
    }
    case 'policy': {
      const policy = policyOf(value['policy']);
      return policy === null ? null : { type: 'policy', policy };
    }
    case 'refused': {
      const reason = text(value['reason'], 4_096);
      return reason === null ? null : { type: 'refused', reason };
    }
    case 'call':
      return callOf(value);
    case 'ping':
      return { type: 'ping' };
    case 'pong':
      return { type: 'pong' };
    default:
      return null;
  }
}
