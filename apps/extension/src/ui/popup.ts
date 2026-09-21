/**
 * The toolbar popup: what is connected, what is open, and the way to stop it.
 *
 * Issue #436 asks for "a stop button in the toolbar", and this is it. The
 * button is deliberately the most prominent thing here and deliberately does
 * everything at once — closes every Artemis tab, detaches the debugger from all
 * of them and disconnects — because a stop that leaves any of those behind is
 * not the thing the user pressed the button for.
 *
 * It does not unpair. Stopping is "not now"; unpairing is "not this browser",
 * and that lives on the options page where there is room to explain it.
 */

import { STATE_CHANGED, type ExtensionState, type UiResponse } from '../state.js';
import { statusLine } from './present.js';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const dot = el<HTMLSpanElement>('dot');
const statusText = el<HTMLSpanElement>('status');
const detailText = el<HTMLParagraphElement>('detail');
const runsBody = el<HTMLTableSectionElement>('runs');
const stopButton = el<HTMLButtonElement>('stop');
const resumeButton = el<HTMLButtonElement>('resume');

async function ask(request: unknown): Promise<UiResponse> {
  return (await chrome.runtime.sendMessage(request)) as UiResponse;
}

function render(state: ExtensionState): void {
  const line = statusLine(state);
  dot.className = `dot ${state.status}`;
  statusText.textContent = line.headline;
  detailText.textContent = line.detail ?? '';

  stopButton.hidden = state.status === 'stopped';
  stopButton.disabled = state.status === 'unpaired';
  resumeButton.hidden = state.status !== 'stopped';

  runsBody.replaceChildren();
  if (state.runs.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'empty';
    cell.textContent = 'No pages open.';
    row.append(cell);
    runsBody.append(row);
    return;
  }
  for (const run of state.runs) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    // `textContent`, because a runKey is a string Artemis chose and this is a
    // page that can reach `chrome.*`.
    cell.textContent = run.runKey;
    row.append(cell);
    runsBody.append(row);
  }
}

async function refresh(): Promise<void> {
  const answer = await ask({ type: 'state' });
  if ('state' in answer) render(answer.state);
}

stopButton.addEventListener('click', () => {
  void ask({ type: 'stop' }).then(refresh);
});

resumeButton.addEventListener('click', () => {
  void ask({ type: 'resume' }).then(refresh);
});

el<HTMLButtonElement>('options').addEventListener('click', () => {
  window.open(chrome.runtime.getURL('options.html'), '_blank');
});

chrome.runtime.onMessage.addListener((message) => {
  if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === STATE_CHANGED) void refresh();
  return false;
});

void refresh();
