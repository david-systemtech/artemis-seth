/**
 * The service worker: one socket, one driver, and the state between them.
 * ============================================================================
 *
 * Everything else in this package is a piece that can be reasoned about alone.
 * This is where they are wired to each other and to Chrome, so it is where the
 * awkward facts of MV3 live, and there are three of them.
 *
 * ## The worker is stopped whenever Chrome likes
 *
 * An MV3 service worker is not a background page. It is started by an event and
 * stopped about thirty seconds after the last one, and every variable in it
 * goes with it. So nothing that matters is only in memory: the pairing, the
 * port, the policy, the run-to-tab map and the audit log are in
 * `chrome.storage.local`; the console buffers are in `chrome.storage.session`,
 * which is the right lifetime for them because a browser restart closes the
 * tabs they describe. {@link start} runs on every wake and rebuilds from those.
 *
 * ## Traffic on the socket is what keeps it alive
 *
 * Since Chrome 116 a WebSocket message resets the worker's idle timer, so a
 * ping inside the thirty-second window keeps both the worker and the connection
 * up for as long as Artemis is there. {@link KEEPALIVE_MS} is twenty seconds,
 * which leaves room for a slow round trip. `setInterval` alone would not do it:
 * the interval dies with the worker that set it, and a worker that has died
 * cannot redial. That is what the alarm is for — `chrome.alarms` survives the
 * worker, fires every thirty seconds, and starting up to answer it is what
 * brings the extension back to knock on Artemis's port again.
 *
 * ## Nothing reconnects after "Stop Artemis"
 *
 * The stop is a stored flag, not a variable, for exactly the reason above: a
 * flag in memory would be cleared by the next alarm, and the user would find
 * the browser being driven again a minute after they told it to stop. Only the
 * popup or the options page clears it.
 */

import {
  BRIDGE_DEFAULT_PORT,
  DEFAULT_PAGE_POLICY,
  type BridgeCall,
  type BridgeFromExtension,
  type ConsoleEntry,
  type DriverResult,
  type PagePolicy,
} from '@rx-artemis/protocol';

import { appendAudit, auditFromStorage, auditHost, type AuditEntry } from './audit.js';
import { bridgeUrl, isBridgeUrl } from './bridge/address.js';
import { backoffDelay } from './bridge/backoff.js';
import { BridgeHandshake, type BridgeCredential } from './bridge/handshake.js';
import { parseFromArtemis } from './bridge/messages.js';
import { ChromePageHost } from './chromeHost.js';
import { thisBrowserName } from './naming.js';
import type { BufferSnapshot } from './page/buffer.js';
import { PageRunner } from './page/driver.js';
import type { TabBookSnapshot } from './page/tabBook.js';
import { asPort, asRecord, dropLocal, readLocal, readSession, writeLocal, writeSession } from './store.js';
import { asUiRequest, LOCAL_KEYS, SESSION_KEYS, STATE_CHANGED, type ExtensionState, type UiRequest, type UiResponse } from './state.js';

/** How often a ping goes out while the socket is up. Inside the 30 s window. */
const KEEPALIVE_MS = 20_000;

/** The alarm that restarts a stopped worker. Chrome's floor is thirty seconds. */
const WAKE_ALARM = 'artemis.wake';
const WAKE_PERIOD_MINUTES = 0.5;

/** How long the console buffers may sit in memory before being written down. */
const PERSIST_DEBOUNCE_MS = 250;

const host = new ChromePageHost();
const runner = new PageRunner({ host, onStateChanged: () => schedulePersist() });

/** Live for as long as this worker is. Rebuilt by {@link start} on every wake. */
let socket: WebSocket | null = null;
let handshake: BridgeHandshake | null = null;
let status: ExtensionState['status'] = 'unpaired';
let detail: string | undefined;
let credential: BridgeCredential | null = null;
/**
 * The label the user gave this browser, or `null` before they gave one.
 *
 * Kept beside the credential because it is written at the same moment and read
 * on every connection: it is sent at pairing, and sent again in each `hello`
 * so that an Artemis which lost its store has something to show. Artemis does
 * not take it back over a rename made in its own Browser pane — see
 * `BridgeHello.browserName` — so this is the name of record only until
 * somebody edits it there.
 */
let browserName: string | null = null;
let policy: PagePolicy | null = null;
let port = BRIDGE_DEFAULT_PORT;
/** The code the user typed, alive only for the connection that spends it. */
let pairingCode: string | null = null;
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let starting: Promise<void> | null = null;

/* -------------------------------------------------------------------------- */
/* Starting up                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Rebuild this worker from storage and dial if there is anything to dial.
 *
 * Guarded by a promise rather than a boolean: several events can wake a worker
 * at once — an alarm and a debugger event in the same instant — and two
 * concurrent starts would open two sockets to the same Artemis.
 */
function start(): Promise<void> {
  starting ??= (async () => {
    port = await readLocal(LOCAL_KEYS.port, asPort, BRIDGE_DEFAULT_PORT);
    credential = await readLocal(LOCAL_KEYS.credential, asCredential, null);
    browserName = await readLocal(LOCAL_KEYS.browserName, asName, null);
    policy = await readLocal(LOCAL_KEYS.policy, asPolicy, null);
    runner.policy = policy;
    runner.restore({
      book: await readLocal(LOCAL_KEYS.tabs, asTabBook, { tabs: {}, groupId: null }),
      console: await readSession(SESSION_KEYS.buffers, asConsoleBuffers, {}),
    });
    // The adapter filters browser-wide events down to Artemis's tabs from an
    // in-memory set, so it has to be told what a previous worker instance knew.
    host.adopt(runner.book.allTabs());

    await chrome.alarms.create(WAKE_ALARM, { periodInMinutes: WAKE_PERIOD_MINUTES });

    if (await readLocal(LOCAL_KEYS.stopped, asBoolean, false)) {
      setStatus('stopped', 'Artemis was stopped in this browser. Reconnect from the Artemis toolbar button.');
      return;
    }
    if (credential === null) {
      setStatus('unpaired');
      return;
    }
    connect();
  })();
  return starting;
}

/** Everything that can wake a stopped worker, and the one thing each does. */
chrome.runtime.onStartup.addListener(() => void start());
chrome.runtime.onInstalled.addListener(() => void start());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WAKE_ALARM) return;
  void start().then(() => {
    // The alarm is also the second half of the keepalive: a worker that was
    // stopped mid-connection comes back with no socket, and this is what
    // notices and redials.
    if (socket === null && status !== 'stopped' && status !== 'unpaired') connect();
  });
});

// A worker started by any other event — a debugger event, a message from the
// popup — still has to rebuild itself, and this is the top-level call that does
// it. The listeners above are registered synchronously, before the await, which
// is what MV3 requires of an event listener.
void start();

/* -------------------------------------------------------------------------- */
/* The socket                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Dial Artemis, once.
 *
 * The address comes from {@link bridgeUrl} and is checked again by
 * {@link isBridgeUrl} immediately before the socket is constructed. Two checks
 * of one rule, deliberately: this is the line that decides whether a browser
 * full of the user's sessions can be driven from somewhere other than this
 * machine, and it should be impossible to edit this function into something
 * that dials a host without noticing.
 */
function connect(): void {
  if (socket !== null) return;
  clearReconnect();

  const url = bridgeUrl(port);
  if (url === null || !isBridgeUrl(url)) {
    setStatus('refused', `${String(port)} is not a port. Set the port Artemis shows in this extension's options.`);
    return;
  }

  const identity = { browserName: nameInForce(), extensionVersion: chrome.runtime.getManifest().version };
  const pending = new BridgeHandshake({ identity, credential, pairingCode: pairingCode });
  const opening = pending.opening();
  if (opening === null) {
    setStatus('unpaired');
    return;
  }

  setStatus('connecting');
  const dialled = new WebSocket(url);
  socket = dialled;
  handshake = pending;

  dialled.addEventListener('open', () => {
    send(opening);
    beginKeepalive();
  });
  dialled.addEventListener('message', (event) => {
    void onMessage(typeof event.data === 'string' ? event.data : '');
  });
  dialled.addEventListener('close', () => {
    if (socket !== dialled) return;
    teardown();
    // A refusal is Artemis's decision and reconnecting would only collect
    // another one; anything else is Artemis not running, which is normal.
    if (status !== 'refused' && status !== 'stopped') scheduleReconnect();
  });
  dialled.addEventListener('error', () => {
    // `close` always follows, and it is where the reconnect is scheduled. This
    // listener exists so the event is not reported as unhandled.
  });
}

function send(message: BridgeFromExtension): void {
  if (socket === null || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

async function onMessage(raw: string): Promise<void> {
  const message = parseFromArtemis(raw);
  const conversation = handshake;
  if (message === null || conversation === null) return;

  const outcome = await conversation.receive(message);
  switch (outcome.kind) {
    case 'send':
      send(outcome.message);
      return;
    case 'paired':
      credential = outcome.credential;
      pairingCode = null;
      attempt = 0;
      // Before the awaits, all of it. Artemis may send a call in the same
      // breath as the answer to a pairing, and a worker that was still waiting
      // on `chrome.storage` would run that call with no policy and refuse it.
      // Writing the credential down can happen afterwards; deciding what is
      // allowed cannot.
      applyPolicy(outcome.policy);
      setStatus('connected');
      await writeLocal(LOCAL_KEYS.credential, credential);
      return;
    case 'ready':
      attempt = 0;
      applyPolicy(outcome.policy);
      setStatus('connected');
      return;
    case 'policy':
      applyPolicy(outcome.policy);
      return;
    case 'call':
      await answer(outcome.call);
      return;
    case 'refused':
      setStatus('refused', outcome.reason);
      pairingCode = null;
      socket?.close();
      return;
    case 'ignore':
      return;
  }
}

/**
 * Take a policy from Artemis.
 *
 * Synchronous on purpose: what is in force has to change before the next
 * message off the socket is looked at, and writing it to storage — which is
 * only so that a restarted worker can refuse a verb before it has reconnected —
 * can catch up afterwards.
 */
function applyPolicy(next: PagePolicy): void {
  policy = next;
  runner.policy = next;
  announce();
  void writeLocal(LOCAL_KEYS.policy, next);
}

/**
 * Run one call and answer it, whatever happens.
 *
 * The `catch` is not defensive clutter. Artemis is waiting on this `id` and a
 * driver that threw would leave the run blocked until it timed out, so a thrown
 * error becomes the refusal it should have been in the first place.
 */
async function answer(call: BridgeCall): Promise<void> {
  const tabId = runner.book.tabFor(call.runKey);
  let result: DriverResult<unknown>;
  try {
    result = await runner.run(call);
  } catch (error) {
    result = { ok: false, reason: `Artemis's extension failed to run ${call.verb}: ${String(error)}` };
  }
  send({ type: 'result', id: call.id, result });
  await record(call, tabId, result);
}

/**
 * Write one line of the user's log.
 *
 * The host is whichever of three is known: the address the call carried, the
 * address the answer came back with, or the last one this tab was seen on.
 * Most verbs carry no address — `read`, `click`, `console` — and asking the
 * debugger for one would mean a CDP round trip per logged line, so the results
 * that already contain a `url` are what keep {@link lastHost} current.
 */
async function record(call: BridgeCall, tabId: number | null, result: DriverResult<unknown>): Promise<void> {
  const asked = 'url' in call && typeof call.url === 'string' ? call.url : null;
  const answered = result.ok && isLocated(result.value) ? result.value.url : null;
  const nowTabId = runner.book.tabFor(call.runKey) ?? tabId;
  if (answered !== null && nowTabId !== null) lastHost.set(nowTabId, answered);

  const entry: AuditEntry = {
    at: Date.now(),
    runKey: call.runKey,
    verb: call.verb,
    host: auditHost(answered ?? asked ?? (nowTabId === null ? null : (lastHost.get(nowTabId) ?? null))),
    outcome: result.ok ? 'ok' : 'refused',
    ...(result.ok ? {} : { reason: result.reason }),
  };
  const log = await readLocal(LOCAL_KEYS.audit, (value) => auditFromStorage(value), []);
  await writeLocal(LOCAL_KEYS.audit, appendAudit(log, entry));
}

/** Where each tab was last seen, so a verb without an address still logs one. */
const lastHost = new Map<number, string>();

function isLocated(value: unknown): value is { readonly url: string } {
  return typeof value === 'object' && value !== null && typeof (value as { url?: unknown }).url === 'string';
}

/* -------------------------------------------------------------------------- */
/* Keepalive, backoff and teardown                                            */
/* -------------------------------------------------------------------------- */

function beginKeepalive(): void {
  stopKeepalive();
  const tick = (): void => {
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    send({ type: 'ping' });
    keepaliveTimer = setTimeout(tick, KEEPALIVE_MS);
  };
  keepaliveTimer = setTimeout(tick, KEEPALIVE_MS);
}

function stopKeepalive(): void {
  if (keepaliveTimer !== null) clearTimeout(keepaliveTimer);
  keepaliveTimer = null;
}

function teardown(): void {
  socket = null;
  handshake = null;
  stopKeepalive();
  if (status === 'connected' || status === 'connecting') setStatus('connecting');
}

function scheduleReconnect(): void {
  clearReconnect();
  const wait = backoffDelay(attempt, Math.random());
  attempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, wait);
}

function clearReconnect(): void {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Write the driver's state down, soon.
 *
 * Debounced because a page that logs in a loop would otherwise mean one
 * `chrome.storage` write per console line. The delay is short enough that a
 * worker stopped for being idle — which takes thirty seconds of quiet — cannot
 * lose anything: quiet is exactly when the debounce has long since fired.
 */
function schedulePersist(): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persist();
  }, PERSIST_DEBOUNCE_MS);
}

async function persist(): Promise<void> {
  const snapshot = runner.snapshot();
  await writeLocal(LOCAL_KEYS.tabs, snapshot.book);
  await writeSession(SESSION_KEYS.buffers, snapshot.console);
  announce();
  void paintBadge();
}

/* -------------------------------------------------------------------------- */
/* The two pages                                                              */
/* -------------------------------------------------------------------------- */

function currentState(): ExtensionState {
  return {
    status,
    ...(detail === undefined ? {} : { detail }),
    port,
    browserName: nameInForce(),
    extensionVersion: chrome.runtime.getManifest().version,
    paired: credential !== null,
    runs: runner.book.entries().map((entry) => ({ runKey: entry.runKey, tabId: entry.tabId })),
    policy,
  };
}

function setStatus(next: ExtensionState['status'], why?: string): void {
  status = next;
  detail = why;
  announce();
  void paintBadge();
}

/**
 * Tell any open page that something moved.
 *
 * `sendMessage` with no listener rejects, and there is usually no listener —
 * the popup is shut most of the time. The rejection is swallowed rather than
 * logged because it is the normal case, not an error.
 */
function announce(): void {
  void chrome.runtime.sendMessage({ type: STATE_CHANGED }).catch(() => undefined);
}

/**
 * The toolbar badge: how many conversations have a page open here.
 *
 * The count rather than a dot, because "Artemis has three tabs in this browser"
 * is the fact a user wants at a glance, and a dot would only say that the
 * extension exists.
 */
async function paintBadge(): Promise<void> {
  const open = runner.book.size;
  try {
    await chrome.action.setBadgeText({ text: open === 0 ? '' : String(open) });
    await chrome.action.setBadgeBackgroundColor({ color: status === 'connected' ? '#7C5CFF' : '#7A7A85' });
    await chrome.action.setTitle({ title: `Artemis — ${status}${open === 0 ? '' : `, ${String(open)} open`}` });
  } catch {
    // A badge that will not paint is not a reason to fail anything.
  }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const request = asUiRequest(message);
  if (request === null) return false;
  void handleUi(request).then(respond, (error: unknown) => {
    respond({ ok: false, error: String(error) } satisfies UiResponse);
  });
  // `true` keeps the message channel open for the asynchronous answer above.
  return true;
});

async function handleUi(request: UiRequest): Promise<UiResponse> {
  await start();
  switch (request.type) {
    case 'state':
      return { ok: true, state: currentState() };

    case 'audit':
      return { ok: true, audit: await readLocal(LOCAL_KEYS.audit, (value) => auditFromStorage(value), []) };

    case 'setPort': {
      if (asPort(request.port) === null) return { ok: false, error: 'A port is a whole number between 1 and 65535.' };
      port = request.port;
      await writeLocal(LOCAL_KEYS.port, port);
      closeAndRedial();
      return { ok: true, state: currentState() };
    }

    case 'pair': {
      // A pairing attempt always starts a fresh connection: the code is spent
      // by the first message of one, and offering it on a socket that is
      // already past its handshake would be answered with a refusal.
      pairingCode = request.code.trim();
      credential = null;
      /*
       * The name is stored before the connection is made, not after Artemis
       * answers. It is what the opening message carries, and a worker that
       * Chrome stopped between the two would otherwise dial again and
       * introduce this browser under the machine-derived name — which is the
       * one the user typed over.
       */
      browserName = request.browserName;
      await writeLocal(LOCAL_KEYS.browserName, browserName);
      await dropLocal(LOCAL_KEYS.credential);
      await dropLocal(LOCAL_KEYS.stopped);
      closeAndRedial();
      return { ok: true, state: currentState() };
    }

    case 'unpair': {
      credential = null;
      /*
       * And the name with it. An unpaired browser has no name in Artemis to
       * correspond to, so keeping one would mean the pairing field starting
       * pre-filled with a label from a pairing that no longer exists — which
       * reads as though the browser were still known.
       */
      browserName = null;
      policy = null;
      runner.policy = null;
      pairingCode = null;
      await dropLocal(LOCAL_KEYS.credential);
      await dropLocal(LOCAL_KEYS.browserName);
      await dropLocal(LOCAL_KEYS.policy);
      await runner.stopEverything();
      await persist();
      closeSocket();
      setStatus('unpaired');
      return { ok: true, state: currentState() };
    }

    case 'stop': {
      // Everything at once: the tabs go, the debugger lets go of them, the
      // socket closes, and the flag means none of it comes back on its own.
      await writeLocal(LOCAL_KEYS.stopped, true);
      await runner.stopEverything();
      await persist();
      closeSocket();
      setStatus('stopped', 'Artemis was stopped in this browser. Reconnect from the Artemis toolbar button.');
      return { ok: true, state: currentState() };
    }

    case 'resume': {
      await dropLocal(LOCAL_KEYS.stopped);
      attempt = 0;
      if (credential === null) {
        setStatus('unpaired');
        return { ok: true, state: currentState() };
      }
      closeAndRedial();
      return { ok: true, state: currentState() };
    }
  }
}

function closeSocket(): void {
  clearReconnect();
  const open = socket;
  socket = null;
  handshake = null;
  stopKeepalive();
  open?.close();
}

function closeAndRedial(): void {
  closeSocket();
  attempt = 0;
  connect();
}

/* -------------------------------------------------------------------------- */
/* Shapers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What this browser calls itself right now.
 *
 * The stored label wins; `naming.ts` is the fallback and the field's starting
 * text. A browser that has never been paired has no label and there is nothing
 * dishonest about "Chrome on Windows" then — it is what the browser can say
 * about itself, and the user is about to say better.
 */
function nameInForce(): string {
  return browserName ?? thisBrowserName();
}

/** A stored label: a non-empty string, bounded as the options page bounds it. */
function asName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 80);
}

function asCredential(value: unknown): BridgeCredential | null {
  const record = asRecord(value);
  if (record === null) return null;
  const browserId = record['browserId'];
  const secret = record['secret'];
  return typeof browserId === 'string' && typeof secret === 'string' ? { browserId, secret } : null;
}

function asPolicy(value: unknown): PagePolicy | null {
  const record = asRecord(value);
  if (record === null) return null;
  const list = (field: unknown): readonly string[] =>
    Array.isArray(field) ? field.filter((entry): entry is string => typeof entry === 'string') : [];
  return {
    ...DEFAULT_PAGE_POLICY,
    devSites: list(record['devSites']),
    blockedSites: list(record['blockedSites']),
    unblockedSites: list(record['unblockedSites']),
    evaluateEverywhere: record['evaluateEverywhere'] === true,
    deepReadEverywhere: record['deepReadEverywhere'] === true,
  };
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * Console buffers as they come back out of session storage.
 *
 * Shaped down to entries with the three fields the contract requires, because
 * what is written here is a serialised class and what comes back is whatever
 * JSON survived. A buffer that fails the shape is dropped rather than repaired:
 * the cost is one tab's console history, and the alternative is a half-valid
 * entry reaching an agent as though it were something the page really said.
 */
function asConsoleBuffers(value: unknown): Readonly<Record<string, BufferSnapshot<ConsoleEntry>>> | null {
  const record = asRecord(value);
  if (record === null) return null;
  const kept: Record<string, BufferSnapshot<ConsoleEntry>> = {};
  for (const [tabId, snapshot] of Object.entries(record)) {
    const shaped = asRecord(snapshot);
    if (shaped === null || !Array.isArray(shaped['entries'])) continue;
    const entries = shaped['entries'].filter(
      (entry): entry is ConsoleEntry =>
        asRecord(entry) !== null && typeof (entry as ConsoleEntry).text === 'string' && typeof (entry as ConsoleEntry).at === 'number',
    );
    kept[tabId] = { entries, dropped: typeof shaped['dropped'] === 'number' ? shaped['dropped'] : 0 };
  }
  return kept;
}

function asTabBook(value: unknown): TabBookSnapshot | null {
  const record = asRecord(value);
  if (record === null) return null;
  const tabs = asRecord(record['tabs']) ?? {};
  const kept: Record<string, number> = {};
  for (const [runKey, tabId] of Object.entries(tabs)) if (typeof tabId === 'number' && Number.isInteger(tabId)) kept[runKey] = tabId;
  return { tabs: kept, groupId: typeof record['groupId'] === 'number' ? record['groupId'] : null };
}
