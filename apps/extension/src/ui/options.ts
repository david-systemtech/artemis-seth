/**
 * The options page: pair, set the port, read the log.
 *
 * It holds no state of its own. Every render is the answer to a `state`
 * request, and the worker sends {@link STATE_CHANGED} when anything moves — see
 * `state.ts` for why. That makes the page immune to the failure an MV3 UI
 * usually has, which is showing "connected" about a socket that closed while
 * the page was open.
 *
 * Text is set with `textContent` throughout and never with `innerHTML`. The
 * strings on this page include a refusal written by Artemis and a `runKey` that
 * came off a socket, and an extension page with an injected script is an
 * extension page that can call `chrome.*`.
 */

import { STATE_CHANGED, type ExtensionState, type UiResponse } from '../state.js';
import { statusLine } from './present.js';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const dot = el<HTMLSpanElement>('dot');
const statusText = el<HTMLSpanElement>('status');
const detailText = el<HTMLParagraphElement>('detail');
const browserName = el<HTMLParagraphElement>('browser-name');
const pairSection = el<HTMLElement>('pair-section');
const pairedSection = el<HTMLElement>('paired-section');
const codeInput = el<HTMLInputElement>('code');
const portInput = el<HTMLInputElement>('port');
const policySummary = el<HTMLParagraphElement>('policy-summary');
const auditBody = el<HTMLTableSectionElement>('audit');

async function ask(request: unknown): Promise<UiResponse> {
  return (await chrome.runtime.sendMessage(request)) as UiResponse;
}

/** Whether the port field holds something the user typed and has not saved. */
let portEdited = false;
portInput.addEventListener('input', () => {
  portEdited = true;
});

function render(state: ExtensionState): void {
  const line = statusLine(state);
  dot.className = `dot ${state.status}`;
  statusText.textContent = line.headline;
  detailText.textContent = line.detail ?? '';
  browserName.textContent = `${state.browserName} · extension ${state.extensionVersion}`;

  pairSection.hidden = state.paired;
  pairedSection.hidden = !state.paired;
  // Not while it is being edited. The worker announces a change on every
  // reconnect attempt, and a reconnect attempt happens about once a second
  // while Artemis is not running — which is exactly when somebody is here
  // correcting the port. Overwriting the field then takes the number out from
  // under them between typing it and pressing Save.
  if (!portEdited) portInput.value = String(state.port);

  if (state.policy === null) {
    policySummary.className = 'empty';
    policySummary.textContent = 'No policy yet — Artemis sends one when this browser connects.';
  } else {
    policySummary.className = '';
    const dev = state.policy.devSites.length === 0 ? 'none listed' : state.policy.devSites.join(', ');
    policySummary.textContent =
      `Cookie values, storage and JavaScript are allowed on this machine's own addresses and on the sites you are developing (${dev}). ` +
      `Everywhere else: page text, screenshots, clicks, typing, the console and the network log, and cookie names without their values. ` +
      (state.policy.evaluateEverywhere ? 'JavaScript is allowed everywhere. ' : '') +
      (state.policy.deepReadEverywhere ? 'Deep reads are allowed everywhere. ' : '') +
      `Blocked in addition to the built-in list: ${state.policy.blockedSites.length === 0 ? 'none' : state.policy.blockedSites.join(', ')}. ` +
      'Change any of this in Artemis settings.';
  }
}

function renderAudit(entries: readonly { at: number; runKey: string; verb: string; host: string; outcome: string; reason?: string }[]): void {
  auditBody.replaceChildren();
  if (entries.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'empty';
    cell.textContent = 'Nothing yet.';
    row.append(cell);
    auditBody.append(row);
    return;
  }
  for (const entry of [...entries].reverse()) {
    const row = document.createElement('tr');
    for (const [text, className] of [
      [new Date(entry.at).toLocaleString(), ''],
      [entry.runKey, ''],
      [entry.verb, ''],
      [entry.host, ''],
      [entry.outcome === 'ok' ? 'ok' : (entry.reason ?? 'refused'), entry.outcome === 'ok' ? '' : 'refused'],
    ] as const) {
      const cell = document.createElement('td');
      cell.textContent = text;
      if (className.length > 0) cell.className = className;
      row.append(cell);
    }
    auditBody.append(row);
  }
}

async function refresh(): Promise<void> {
  const answer = await ask({ type: 'state' });
  if ('state' in answer) render(answer.state);
}

async function refreshAudit(): Promise<void> {
  const answer = await ask({ type: 'audit' });
  if ('audit' in answer) renderAudit(answer.audit);
}

el<HTMLButtonElement>('pair').addEventListener('click', () => {
  const code = codeInput.value.trim();
  if (code.length === 0) return;
  codeInput.value = '';
  void ask({ type: 'pair', code }).then(refresh);
});

el<HTMLButtonElement>('unpair').addEventListener('click', () => {
  void ask({ type: 'unpair' }).then(refresh);
});

el<HTMLButtonElement>('save-port').addEventListener('click', () => {
  void ask({ type: 'setPort', port: Number(portInput.value) }).then(() => {
    portEdited = false;
    return refresh();
  });
});

el<HTMLButtonElement>('refresh-audit').addEventListener('click', () => {
  void refreshAudit();
});

chrome.runtime.onMessage.addListener((message) => {
  if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === STATE_CHANGED) {
    void refresh();
    void refreshAudit();
  }
  return false;
});

void refresh();
void refreshAudit();
