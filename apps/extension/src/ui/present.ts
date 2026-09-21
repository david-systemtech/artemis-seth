/**
 * The sentences the two pages show for each connection state.
 *
 * Here rather than inline in the pages for two reasons. The popup and the
 * options page must not describe the same state differently — "connected" in
 * one and "paired" in the other is how a user ends up unsure whether it is
 * working. And this is the only part of either page worth a test, because it is
 * the only part with a decision in it.
 *
 * "Connected to Artemis" rather than "active" or "enabled": the user's question
 * is whether the thing on the other end of this is running, and the answer
 * should use its name.
 */

import type { ExtensionState } from '../state.js';

export interface StatusLine {
  readonly headline: string;
  readonly detail?: string;
}

export function statusLine(state: ExtensionState): StatusLine {
  switch (state.status) {
    case 'unpaired':
      return {
        headline: 'Not paired',
        detail: 'Open Artemis, find the pairing code in Settings, and type it on this extension’s options page.',
      };
    case 'connecting':
      return {
        headline: 'Connecting…',
        detail: state.detail ?? `Waiting for Artemis on port ${String(state.port)} of this machine. It may simply not be running.`,
      };
    case 'connected':
      return {
        headline: 'Connected to Artemis',
        detail:
          state.runs.length === 0
            ? 'No conversation has a page open here yet.'
            : `${String(state.runs.length)} ${state.runs.length === 1 ? 'conversation has a page' : 'conversations have pages'} open here.`,
      };
    case 'refused':
      return { headline: 'Refused', detail: state.detail ?? 'Artemis would not accept this browser.' };
    case 'stopped':
      return {
        headline: 'Stopped',
        detail: state.detail ?? 'Artemis was stopped in this browser and will not reconnect until you say so.',
      };
  }
}
