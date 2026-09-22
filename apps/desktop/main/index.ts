/**
 * Artemis — Electron main process.
 *
 * This process owns everything the renderer is not allowed to touch: decrypted
 * API keys, the filesystem, and the engine that drives agent runs. It is the
 * only place in Artemis where a credential exists in plaintext, and then only for
 * as long as it takes to hand it to a provider's environment bundle.
 *
 * Startup order matters and is deliberate:
 *
 *  1. Sandbox and single-instance locks, before the app is ready — both are
 *     no-ops if set later.
 *  2. Probe the OS credential store, so a machine that cannot encrypt is
 *     discovered before the user types a key into a form that will then fail.
 *  3. Apply session-wide security policy *before* any window exists, so no
 *     window is ever briefly unprotected.
 *  4. Start the engine, register IPC, and only then open a window.
 *
 * A failure at step 2 or 4 does not stop the app. Artemis opens anyway and tells
 * the user what is wrong — an app that refuses to launch cannot explain itself.
 */

import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, session } from 'electron';

import {
  IPC_PUSH,
  PREFS_READ_CHANNEL,
  PREFS_WRITE_CHANNEL,
  SUGGESTED_TASK_SERVER,
  type RunId,
} from '@rx-artemis/protocol';

import {
  MEMORY_TOOL_SERVER,
  memoryToolServer,
  profilesRoot,
  setBrowserRelayClient,
} from '@rx-artemis/core';

import { APP_NAME, flavouredAppName, previousUserDataDir } from './appNames.js';
import { configurePrefs, readPrefsSync, writePrefs } from './prefs.js';
import { createRemoteAccess } from './remoteAccess.js';

/**
 * Which build this is: `''` for Artemis, `Beta` for a copy installed beside it.
 *
 * Injected by `electron.vite.config.ts` at build time. The fallback covers the
 * unbundled paths — `electron-vite dev` and anything that imports this module
 * without going through the bundler — where the define is not substituted.
 */
const FLAVOUR: string = typeof __ARTEMIS_FLAVOUR__ === 'string' ? __ARTEMIS_FLAVOUR__ : '';
import { EngineHost } from './engine.js';
import { stopAllSignInForwarders } from './signInLoopback.js';
import {
  broadcast,
  forwardAgentEvents,
  forwardBrowserEvents,
  forwardRunSuggestions,
  forwardTerminalEvents,
  registerIpcHandlers,
  type IpcLayer,
} from './ipc.js';
import { createLogger } from './log.js';
import { installApplicationMenu } from './menu.js';
import { assertNoSecrets, RESPONSE_SCAN_POLICY } from './redact.js';
import { startPlanUsagePolling } from './planUsagePoll.js';
import { clearPreviews, registerPreviewScheme, servePreviews } from './preview.js';
import { adoptLoginShellPath } from './shellPath.js';
import { BrowserHost } from './browser.js';
import {
  agentBrowserServers,
  browserToolServer,
  extensionBrowserToolServer,
  externalBrowserToolServer,
  releaseEmbeddedDriver,
} from './browserTools.js';
import { createExtensionBridge, type ExtensionBridge } from './extensionBridge.js';
import { extensionPageDriver } from './extensionPageDriver.js';
import { openPairedBrowsers } from './pairedBrowsers.js';
import { suggestedTaskToolServer } from './taskTools.js';
import { banksForRun, isMasterEnabled, memoryToolServerOptions } from './memoryBanks.js';
import { createServerHost, type ServerHost } from './server.js';
import { createRoutineHost, type RoutineHost } from './routines.js';
import { createTerminalHost, type TerminalHost } from './terminal.js';
import { createUpdater } from './updater.js';
import {
  applySessionPolicy,
  hardenWebContents,
  installNetworkAuthGuard,
  openExternalSafely,
  windowSecurityPreferences,
  type SecurityPolicy,
} from './security.js';
import { forwardWindowState, windowChromeOptions } from './window.js';

const log = createLogger('main');

/**
 * Windows application identity.
 *
 * **Kept in sync by hand with `appId` in `apps/desktop/electron-builder.yml`.**
 * There is no runtime accessor for the builder's `appId` — it is baked into the
 * installer, not into anything the app can read back — so the string exists
 * twice and this comment is the link between them. Change one, change the
 * other, or Windows treats the running app and its installed shortcut as two
 * unrelated applications.
 */
const APP_USER_MODEL_ID = FLAVOUR === '' ? 'dev.artemis.app' : `dev.artemis.app.${FLAVOUR.toLowerCase()}`;

/**
 * Set before anything reads a path. See `appNames.ts` for why the name matters
 * and for the rule that governs changing it.
 */
app.setName(flavouredAppName(APP_NAME, FLAVOUR));

/**
 * Where *Artemis's own* data lives — profiles, prompts, session ownership.
 * ============================================================================
 *
 * Deliberately not the same question as `app.getPath('userData')`, and the
 * distinction is the whole reason a flavoured build works at all.
 *
 * That directory holds two unrelated kinds of thing. Chromium owns most of it:
 * the caches, the cookie jar, `Local Storage`, and the `Singleton*` files that
 * *are* the single-instance lock. Artemis owns seven entries beside them —
 * `profiles/`, `profiles.json`, `agent-prompts.json`, `cerebro.json`,
 * `sessionOwners.json`, `update-settings.json`.
 *
 * A flavoured build wants the second set shared and the first set emphatically
 * not. Sharing Chromium's half means sharing the lock, so the two builds cannot
 * run at once — and it means two processes writing one LevelDB, which is how
 * `Local Storage` gets corrupted rather than merged. Sharing Artemis's half is
 * the entire point: a beta that opens with no accounts is a beta you have to
 * set up before you can test anything.
 *
 * So `userData` stays per-name and only *this* points at the release's
 * directory. Both builds run at the same time, on one set of profiles.
 *
 * ## Why not symlink the seven entries instead
 *
 * Because `profiles.json` and `agent-prompts.json` are written whole, to a temp
 * file, and moved into place. An atomic rename *replaces* a symlink with a real
 * file, so the first profile edit would quietly sever the link and leave two
 * registries drifting apart with nothing on screen to say so. A directory
 * symlink would survive; a file symlink would not, and the failure is invisible.
 */
function artemisDataDir(): string {
  const own = app.getPath('userData');
  return FLAVOUR === '' ? own : join(app.getPath('appData'), APP_NAME);
}

/**
 * Adopt the user data left behind by a previous name.
 *
 * Moves the newest surviving directory across, once, on the first launch that
 * finds one. Which one that is, and why the list of candidates only ever grows,
 * is in `appNames.ts`.
 *
 * ## `secrets.v1.json` is deleted rather than carried
 *
 * Artemis no longer has a secret store — the provider's own CLI holds the
 * credential, inside the profile's config directory, which *does* come across
 * with the rename. So the old encrypted file has nothing to be read by. It is
 * removed rather than left in place, because a file of undecryptable
 * ciphertext sitting in the user-data directory invites exactly one question
 * later ("what is this, and does it still matter?") whose answer is "no". Only
 * a Libra-era directory can still contain one; the call is unconditional
 * because `force` makes a miss free and a special case would need a comment
 * longer than the line it saved.
 *
 * Runs before `app.whenReady()` and synchronously, because everything that
 * follows reads `userData`. A failure is logged and swallowed — a migration
 * that cannot complete must not stop the app from starting, it must only mean
 * the user starts fresh.
 */
function adoptPreviousUserData(): void {
  const current = app.getPath('userData');

  try {
    const previous = previousUserDataDir(dirname(current), current, existsSync, join);
    if (previous === null) return;

    renameSync(previous, current);
    // Nothing reads this any more, and nothing can. See above.
    rmSync(join(current, 'secrets.v1.json'), { force: true });
    log.info(`Adopted user data from the previous app name: ${previous} → ${current}`);
  } catch (error) {
    log.error('Could not adopt user data from the previous app name', error);
  }
}

adoptPreviousUserData();

/**
 * Force the sandbox on for every renderer, including any created later by code
 * that forgets to ask for it. Must run before `app.whenReady()`.
 */
app.enableSandbox();

/**
 * Declare the preview scheme. Also before ready, and for the same kind of
 * reason: after `whenReady` this call does nothing and says nothing, and the
 * only evidence is a preview frame that never loads. See `preview.ts`.
 */
registerPreviewScheme();

/** Directory containing the built main bundle (`out/main`). */
const distributionDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * Vite's dev server, when running under `electron-vite dev`.
 *
 * Its presence is what distinguishes development from a packaged app
 * everywhere in this process — including which Content-Security-Policy is
 * applied, so it is read once and threaded through rather than re-derived.
 */
const devServerUrl = process.env['ELECTRON_RENDERER_URL'] ?? null;

let ipcLayer: IpcLayer | null = null;
let stopEventForwarding: (() => void) | null = null;
let stopAskNotifying: (() => void) | null = null;
let stopSuggestionForwarding: (() => void) | null = null;
let stopTerminalForwarding: (() => void) | null = null;
let stopBrowserForwarding: (() => void) | null = null;
let stopBrowserRunCleanup: (() => void) | null = null;
let stopPlanUsagePolling: (() => void) | null = null;
let stopUpdater: (() => void) | null = null;
let serverHost: ServerHost | null = null;
let extensionBridge: ExtensionBridge | null = null;
let stopExtensionRunCleanup: (() => void) | null = null;
let routineHost: RoutineHost | null = null;
let terminals: TerminalHost | null = null;
const browsers = new BrowserHost();
const engineHost = new EngineHost();

/* -------------------------------------------------------------------------- */
/* Window                                                                     */
/* -------------------------------------------------------------------------- */

function buildSecurityPolicy(remoteOrigin?: () => string | null): SecurityPolicy {
  const rendererEntry = join(distributionDir, '..', 'renderer', 'index.html');
  return {
    devServerOrigin: devServerUrl ? new URL(devServerUrl).origin : null,
    rendererFileUrl: pathToFileURL(rendererEntry).toString(),
    ...(remoteOrigin === undefined ? {} : { remoteOrigin }),
  };
}

function createWindow(policy: SecurityPolicy): BrowserWindow {
  const preloadPath = join(distributionDir, '..', 'preload', 'index.cjs');

  const window = new BrowserWindow({
    width: 1_280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: 'Artemis',
    // Painting the window before the renderer has anything to show produces a
    // white flash on a dark desktop. Start hidden, reveal on `ready-to-show`.
    show: false,
    // Hex, and the one colour in this app that lives outside index.css: it is
    // read by Chromium before any stylesheet exists, so it cannot be a token.
    // Both are `--abyss` resolved to sRGB via `lib/oklch.ts` — the seed
    // canvas, `oklch(15.5% 0 0)` dark and `oklch(96.5% 0 0)` light. The
    // values before these were the 250-tinted greys of the teal palette,
    // which is exactly the staleness this comment exists to prevent: when
    // `--abyss` moves, these two hexes move with it.
    //
    // This follows the OS and not the in-app setting, which is a real gap and a
    // deliberately small one. The main process cannot see the renderer's
    // preferences (they are `localStorage`, and this is read while the window is
    // being constructed), so honouring an explicit override would mean a new
    // persisted channel purely for a colour that is almost never on screen: the
    // window is created hidden and revealed on `ready-to-show`, by which point
    // the renderer has painted over all of it. What is left is the sliver
    // Chromium fills during a fast resize, where being one palette out for a
    // frame is a cosmetic near-miss rather than the launch flash the boot script
    // in `index.html` exists to prevent.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c0c0c' : '#f3f3f3',
    autoHideMenuBar: process.platform !== 'darwin',
    // No native title bar: the app's own header is the title bar. What that
    // costs, and what has to be drawn in its place, is in `window.ts`.
    ...windowChromeOptions(),
    webPreferences: windowSecurityPreferences(preloadPath, [
      `--artemis-version=${app.getVersion()}`,
      `--artemis-platform=${process.platform}`,
      // Releases carry one update feed per architecture, so this is not
      // decoration: it is the difference between the build a user is running and
      // the one they would download by hand. The About pane prints it.
      `--artemis-arch=${process.arch}`,
    ]),
  });

  window.once('ready-to-show', () => window.show());

  // Maximized, full screen and focused are invisible from inside the page, and
  // the header draws with all three. The listeners die with the window, so the
  // disposer is deliberately dropped rather than tracked.
  forwardWindowState(window);

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    void window.loadFile(join(distributionDir, '..', 'renderer', 'index.html'));
  }

  // `app.on('web-contents-created')` already hardened this one. Calling again
  // is a deliberate belt-and-braces: `hardenWebContents` is idempotent, and a
  // future refactor that drops the app-level hook should not silently produce
  // an unguarded window.
  hardenWebContents(window.webContents, policy);

  return window;
}

function focusExistingWindow(): void {
  const [existing] = BrowserWindow.getAllWindows();
  if (!existing) return;
  if (existing.isMinimized()) existing.restore();
  existing.focus();
}

/* -------------------------------------------------------------------------- */
/* Startup diagnostics                                                        */
/* -------------------------------------------------------------------------- */

function reportEngineProblem(): void {
  if (engineHost.ready) return;
  const detail = engineHost.failureMessage ?? 'The engine did not start.';
  log.error(`Engine unavailable: ${detail}`);
  dialog.showErrorBox(
    'Artemis could not start its engine',
    `${detail}\n\nRuns and profiles are unavailable. If you are running from source, build the workspace ` +
      'packages first (`pnpm build:libs`) and restart Artemis.',
  );
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A second `artemis` process should raise the first one's window, not open a
 * second copy with a second engine writing the same profile file.
 *
 * The lock is keyed to `app.getPath('userData')`, which stays per-app-name —
 * so a flavoured build has its own and is *not* refused while the release is
 * open. That is deliberate; see `artemisDataDir` for what the two builds share
 * and what they keep apart.
 */
if (!app.requestSingleInstanceLock()) {
  log.info('Another Artemis instance is already running; exiting.');
  app.quit();
} else {
  app.on('second-instance', focusExistingWindow);
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  // Before anything spawns by name: a Finder launch arrives with launchd's
  // bare PATH, on which the user's `claude` and `gh` do not exist. See
  // shellPath.ts — this is the difference between the installed app working
  // and `spawn claude ENOENT`.
  await adoptLoginShellPath();

  // Windows uses this to group taskbar entries and route notifications.
  //
  // This must be byte-identical to `appId` in electron-builder.yml. The NSIS
  // installer stamps that value onto the Start Menu shortcut, and Windows
  // matches a running process to its shortcut by AUMID alone: a mismatch means
  // the live window does not coalesce with the installed entry, pinning it
  // creates a second pin, and notifications are dropped because the Action
  // Center cannot resolve the id to a shortcut.
  app.setAppUserModelId(APP_USER_MODEL_ID);

  /*
   * The remote-origin grant, loaded before the security policy is applied: an
   * app that was left connected to another machine reloads its renderer
   * straight into remote mode, and that renderer's first fetch must find the
   * CSP already naming the origin. The policy holds a *getter*, so a grant
   * configured later in this launch applies without a restart too.
   */
  const remoteAccess = createRemoteAccess(artemisDataDir());
  await remoteAccess.load();

  const policy = buildSecurityPolicy(() => remoteAccess.origin());

  // Order matters: the session policy and the `web-contents-created` hook are
  // installed before any window exists, so there is no window that was ever
  // unprotected — not even for one paint.
  applySessionPolicy(session.defaultSession, policy);
  installNetworkAuthGuard(app);
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents, policy));

  // After the session policy, so the handler this installs is already covered by
  // the request lockdown's preview exemption rather than racing it.
  servePreviews();

  // Artemis's own root, which for a flavoured build is the release's — see
  // `artemisDataDir`. Everything below this line reads profiles and prompts,
  // never Chromium state, which is exactly the split that function draws.
  const userDataDir = artemisDataDir();
  /*
   * Before any window exists, because the renderer reads these synchronously in
   * the same tick it decides the font scale and the palette — see `prefs.ts`.
   */
  configurePrefs(userDataDir);
  /*
   * Registered here rather than in `ipc.ts`, and it is the one channel that is
   * not an `invoke`.
   *
   * `ipc.ts` is the validated request/response surface: every channel there is
   * asynchronous, schema-checked and scanned for credentials on the way out.
   * This is neither a request nor a response — it is one synchronous read of a
   * local file that has to complete before the renderer's first paint, because
   * what it returns decides the font scale and the palette. Routing it through
   * the async surface would mean painting the app at the default size in the
   * default theme and correcting it a frame later: a flash on every launch.
   *
   * The blob is opaque to main and never leaves the machine, so there is
   * nothing here for the response scanner to check — see `prefs.ts`.
   */
  ipcMain.on(PREFS_READ_CHANNEL, (event) => {
    event.returnValue = readPrefsSync();
  });
  ipcMain.on(PREFS_WRITE_CHANNEL, (_event, json: unknown) => {
    if (typeof json === 'string') void writePrefs(json);
  });
  // Where Artemis's *suggested* config directories live. A profile may point
  // anywhere, but the suggestions land here and hold real logins and
  // transcripts, so the root is created owner-only rather than inheriting the
  // process umask. Core creates each directory inside it on demand.
  await mkdir(profilesRoot(userDataDir), { recursive: true, mode: 0o700 }).catch((error: unknown) => {
    log.error('Could not create the profiles directory', error);
  });

  /*
   * The extension bridge, before the engine, because a run's browser tools
   * close over it — and before any window, so a pane that opens immediately
   * finds a state to draw rather than an empty one it has to re-fetch.
   *
   * Started but not awaited for its *outcome* beyond binding: a port that is
   * taken is a state the Browser pane renders, exactly as a taken server port
   * is, and not a reason for Artemis to fail to open.
   */
  const pairedBrowsers = await openPairedBrowsers(userDataDir);
  extensionBridge = createExtensionBridge({
    store: pairedBrowsers,
    bundledVersion: bundledExtension()?.version ?? null,
    onStateChange: (state) => broadcast(IPC_PUSH.extensionBridgeState, state),
  });
  await extensionBridge.start();
  /*
   * And this machine's browser is now something a *server* can ask for.
   *
   * A conversation whose agent runs on an Artemis Server sends its browser
   * verbs back down the connection it came in on, and this is the answer to
   * them: the same `ExtensionPageDriver` a local run gets, so a served run
   * drives the same Chrome under the same policy and — when there is no
   * browser to be had — reads the same refusal sentences.
   *
   * Registered here, once, for the whole process. Until it is, the adapter
   * does not ask a server for a browser at all, which is the honest lesser
   * feature rather than a run waiting out deadlines nobody will answer.
   */
  setBrowserRelayClient((runKey, browserId) =>
    extensionPageDriver(runKey as RunId, requireExtensionBridge(), { browser: browserId }),
  );

  const sdkExecutablePath = bundledSdkExecutablePath();
  await engineHost.start({
    userDataDir,
    appVersion: app.getVersion(),
    ...(sdkExecutablePath === undefined ? {} : { sdkExecutablePath }),
    /*
     * The agent's own tools, built per run.
     *
     * This is the composition root doing the one thing only it can: `core` is
     * forbidden from importing Electron, and a tool that drives a
     * `WebContentsView` is Electron all the way down. So the factory is handed
     * across the wall here, closing over the host that owns the views.
     */
    agentToolServers: (runId, input) => {
      /*
       * The memory tools, when there is something for them to reach.
       *
       * Two gates, and they are the same two the prompt's built-in answers to:
       * the user has switched the banks on for Artemis, and this run's account
       * carries at least one. A run that fails either gets no server at all
       * rather than an empty one — a tool the model can call and be told "no
       * bank reaches this run" teaches it the feature is broken.
       *
       * Everything the server needs beyond the run itself comes from
       * `memoryBanks.ts`, which owns the locations and the credentials; this
       * root supplies only what only a run knows.
       */
      const memory =
        isMasterEnabled() && banksForRun(input.profileId).length > 0
          ? memoryToolServerOptions(input)
          : null;

      return {
        /*
         * Which browser the agent gets is the run input's call — see the
         * decision table on `agentBrowserServers`. The builders are lazy so a
         * run that gets the Chrome bridge (or the external opener) never
         * constructs the embedded server it will not use. It answers
         * `undefined` for the Chrome case, which spreads to nothing.
         */
        ...agentBrowserServers(input, {
          embedded: () =>
            browserToolServer(runId, {
              ensure: (run, url) => browsers.openForAgent(run, url),
              current: (run) => browsers.agentBrowserFor(run),
              host: browsers,
            }),
          // The same guarded door every other external open goes through: the
          // tool has already vetted the scheme, and this vets it again on the
          // way out because model output does not get a second-chance rule.
          external: () => externalBrowserToolServer((url) => openExternalSafely(url)),
          /*
           * The user's own Chrome, through the bridge the extension dialled
           * in on. Built even when nothing is paired or connected: the driver
           * answers every verb with a sentence saying so, which is a thing the
           * agent can tell the user. Quietly handing back the dock browser
           * instead would have it report on the wrong cookie jar and never
           * mention the substitution.
           */
          extension: (browserId) =>
            extensionBrowserToolServer(runId, requireExtensionBridge(), {
              browser: browserId,
              /*
               * And when the agent settles the "which browser?" question
               * mid-turn, the conversation moves onto that browser.
               *
               * A push rather than a return value, because the decision
               * happens inside a tool call and the pane that has to learn it
               * is in another process. The renderer routes it by run id to the
               * pane holding the run — see `IPC_PUSH.runBrowserChoice` — so
               * the browser row shows the answer and the next turn starts on
               * it without the user being asked twice.
               */
              onChosen: (chosen) => {
                broadcast(IPC_PUSH.runBrowserChoice, {
                  kind: 'run-browser-choice',
                  runId,
                  browserId: chosen,
                });
              },
            }),
        }),
        /*
         * Suggested tasks, on every run and under no preference.
         *
         * Nothing about it depends on the input: it opens no surface, spends no
         * quota and cannot act, so there is no arrangement of a run in which
         * offering it would be wrong. The only thing that turns it off is a
         * provider that cannot take host tools at all, which never reaches here.
         */
        [SUGGESTED_TASK_SERVER]: suggestedTaskToolServer(),
        ...(memory === null ? {} : { [MEMORY_TOOL_SERVER]: memoryToolServer(memory) }),
      };
    },
  });

  // The updater exists before the IPC layer because the layer's handlers
  // close over it; it *starts* after the window exists so its first push has
  // somewhere to land. In dev builds start() is a no-op — see updater.ts.
  const updater = createUpdater({
    userDataDir,
    broadcast: (state) => broadcast(IPC_PUSH.updateState, state),
  });
  stopUpdater = () => updater.stop();

  // Before the window, like everything else that must never be half-installed
  // while something can already be clicked. macOS only, and it replaces the
  // default menu wholesale — see menu.ts for what that costs.
  installApplicationMenu({
    updater,
    // Main cannot open the dialog — Settings are renderer state — so the click
    // travels as a push and the renderer decides what to do with it.
    onOpenSettings: () => broadcast(IPC_PUSH.menuOpenSettings, { kind: 'open-settings' }),
  });

  // After `adoptLoginShellPath`, which has by now corrected `process.env.PATH` —
  // a shell inherits that env, so a terminal opened from a Finder launch finds
  // the same tools a terminal launch would.
  terminals = createTerminalHost();

  // Created before the IPC layer, whose handlers close over it, and *started*
  // after — see below. Nothing here binds a port yet.
  serverHost = createServerHost({
    engine: engineHost,
    userDataDir,
    appVersion: app.getVersion(),
    broadcast: (state) => broadcast(IPC_PUSH.serverState, state),
    // Constructed just above, and handed over rather than re-created: a remote
    // window's shells are this machine's shells, spawned by the one file that
    // is allowed to spawn them. See `ServerHostOptions.terminals`.
    terminals,
  });

  // Same construction order as the server host, for the same reason: the IPC
  // layer's handlers close over it. Notifications are wired here because the
  // host itself must stay runnable outside Electron.
  routineHost = createRoutineHost({
    engine: engineHost,
    userDataDir,
    // Scanned before it goes out, the way the plan-usage poller scans its own
    // pushes: a push is not a weaker boundary than an invoke reply. A failing
    // state is dropped and logged rather than sent.
    broadcast: (state) => {
      try {
        assertNoSecrets(state, IPC_PUSH.routinesState, RESPONSE_SCAN_POLICY);
      } catch (error) {
        log.error('Dropped a routines push: it failed its credential-safety check', error);
        return;
      }
      broadcast(IPC_PUSH.routinesState, state);
    },
    notify: (title, body) => {
      if (!Notification.isSupported()) return;
      new Notification({ title, body }).show();
    },
  });

  ipcLayer = registerIpcHandlers({
    engine: engineHost,
    policy,
    updater,
    terminals,
    browsers,
    server: serverHost,
    routines: routineHost,
    remoteAccess,
    extensionBridge: requireExtensionBridge(),
    bundledExtension,
  });
  stopEventForwarding = forwardAgentEvents(engineHost);
  stopSuggestionForwarding = forwardRunSuggestions(engineHost);
  /*
   * A run that has ended lets go of its tab in the user's Chrome.
   *
   * The dock browser deliberately does *not* do this — its tab belongs to the
   * user's strip and they may still be reading it — but a tab the extension
   * opened lives in a tab group Artemis put there, and a week of conversations
   * leaving one behind each is a browser nobody can find anything in.
   *
   * On the run's own event stream rather than in the tool factory, because the
   * factory is called when a run starts and has no hook for when it stops.
   */
  stopExtensionRunCleanup = engineHost.ready
    ? engineHost.require().subscribe((event) => {
        if (event.type !== 'run.end') return;
        extensionBridge?.endRun(event.runId);
      })
    : null;
  /*
   * A question the agent stops to ask waits for the person it was asked of —
   * the server no longer answers on their behalf after a quarter of an hour
   * (see `server/runs.ts`) — so the person has to find out it is waiting. The
   * pane pins the card and the sidebar marks the session, but both are only
   * visible to someone looking at Artemis. When no window is focused, an OS
   * notification says so once per question; when one is, the card in the
   * pane is the notification, and a system toast over it would be noise.
   */
  stopAskNotifying = engineHost.ready
    ? engineHost.require().subscribe((event) => {
        if (event.type !== 'permission.request') return;
        if (BrowserWindow.getFocusedWindow() !== null) return;
        if (!Notification.isSupported()) return;
        new Notification({
          title: 'Waiting for your answer',
          body: 'An agent stopped to ask you something. It will wait until you answer.',
        }).show();
      })
    : null;
  stopTerminalForwarding = forwardTerminalEvents(terminals);
  stopBrowserForwarding = forwardBrowserEvents(browsers);
  /*
   * A run that has ended lets go of the dock tab it was driving.
   *
   * Not a close: the tab belongs to the user's strip and they may still be
   * reading it. What is released is what the driver attached to it — a
   * `console-message` handler, a `did-fail-load` handler, a console buffer and
   * a slot in the session's request recorder. A driver is built per *run*, so
   * without this a conversation's twentieth turn left twenty of each on one
   * `webContents`, in a process the user cannot restart without losing their
   * work.
   *
   * On the run's own event stream rather than in the tool factory, because the
   * factory is called when a run starts and has no hook for when it stops.
   * `apps/server/src/host.ts` closes a served run's tab off the same kind of
   * feed, for a related but different reason: that tab is nobody's.
   */
  stopBrowserRunCleanup = engineHost.ready
    ? engineHost.require().subscribe((event) => {
        if (event.type !== 'run.end') return;
        releaseEmbeddedDriver(event.runId);
      })
    : null;
  // Reads every profile's plan limits on a timer, so the profile menu can say
  // which account has room. Started after IPC so its first push has somewhere
  // to land, and before the window so the schedule does not depend on how long
  // the renderer takes to boot.
  stopPlanUsagePolling = startPlanUsagePolling(engineHost);

  createWindow(policy);
  updater.start();

  /*
   * The server reads its config and, if the user asked for autostart, binds.
   *
   * After the window rather than before it, for the reason the updater is:
   * every outcome here — bound, or failed with a port in use — is news the
   * pane renders, and news broadcast before a window exists is news nobody
   * hears. Not awaited, because a bind is not something Artemis's startup
   * should wait on: the app is fully usable while it is happening, and a
   * failure is a state on a settings pane rather than a boot error.
   */
  void serverHost.start().catch((error: unknown) => {
    log.error('Could not start the local server', error);
  });

  /*
   * The routines host reads its file, fires any make-up run the closed app
   * owed, and starts the minute tick. After the window for the server host's
   * reason — a catch-up firing is news the sidebar renders — and un-awaited
   * for the same one: the schedule is not something startup waits on.
   */
  void routineHost.start().catch((error: unknown) => {
    log.error('Could not start the routines host', error);
  });

  reportEngineProblem();

  app.on('activate', () => {
    // macOS: clicking the dock icon with no windows open should reopen one.
    if (BrowserWindow.getAllWindows().length === 0) createWindow(policy);
  });
}

/**
 * The bridge, or a refusal that names the bug rather than crashing a run.
 *
 * `bootstrap` creates it before the engine and nothing builds a tool server
 * before that, so `null` here is a startup-ordering mistake and not a state a
 * user can reach. The throw is what makes such a mistake a test failure
 * instead of a conversation whose browser tools silently did nothing.
 */
function requireExtensionBridge(): ExtensionBridge {
  if (extensionBridge === null) {
    throw new Error('The extension bridge was asked for before it was created.');
  }
  return extensionBridge;
}

/**
 * The browser extension this build ships, if it ships one.
 *
 * A zip and a version, written into `resources/` by electron-builder's
 * `extraResources` (see `electron-builder.yml`) from what the release
 * workflow built. Two files rather than one so the version can be read
 * without opening the archive: the pane compares it against what a paired
 * browser reports, which happens on every connection.
 *
 * `null` in development, where the app is not packaged and there is no
 * `resources/`, and in a packaged build whose extension step did not run. The
 * Browser pane reads that as "there is nothing to save" and says so, which is
 * the honest outcome — the alternative is a button that writes a zero-byte
 * file and a user who loads it into Chrome.
 */
function bundledExtension(): { readonly zipPath: string; readonly version: string } | null {
  if (!app.isPackaged) return null;
  const directory = join(process.resourcesPath, 'extension');
  try {
    const zip = readdirSync(directory).find((name) => name.endsWith('.zip'));
    if (zip === undefined) return null;
    // `artemis-extension-2.19.1.zip` — the version is in the name, so nothing
    // has to be unzipped and no second file has to be kept in step with it.
    const version = /^artemis-extension-(.+)\.zip$/u.exec(zip)?.[1];
    if (version === undefined) return null;
    return { zipPath: join(directory, zip), version };
  } catch {
    return null;
  }
}

/**
 * The Claude Agent SDK's bundled CLI binary, at its real on-disk path.
 *
 * The SDK resolves its platform package relative to its own module, which in
 * a packaged app is a virtual `app.asar/...` path — readable through
 * Electron's patched `fs`, but not spawnable: `child_process.spawn` is not
 * patched, so the raw syscall hits `app.asar` (a file) as a path component
 * and fails with `ENOTDIR`. Both the SDK and its platform package are shipped
 * under `app.asar.unpacked` (see `asarUnpack` in electron-builder.yml); this
 * finds the binary there so the engine can hand the SDK a path that exists on
 * the actual filesystem.
 *
 * Returns undefined in dev (no asar; the SDK's own resolution is correct) and
 * when the binary is missing (the SDK then fails with its own message, which
 * names the real problem instead of a misleading ENOTDIR).
 */
function bundledSdkExecutablePath(): string | undefined {
  if (!app.isPackaged) return undefined;
  const packageDir = join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    `claude-agent-sdk-${process.platform}-${process.arch}`,
  );
  try {
    const binary = readdirSync(packageDir).find(
      (name) => name === 'claude' || name === 'claude.exe',
    );
    return binary === undefined ? undefined : join(packageDir, binary);
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Shutdown                                                                   */
/* -------------------------------------------------------------------------- */

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let shuttingDown = false;
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  shuttingDown = true;

  // Runs own child processes and open file handles. Give the engine a chance to
  // stop them cleanly rather than orphaning them, but do not let a hung
  // adapter make the app unquittable.
  event.preventDefault();
  stopEventForwarding?.();
  stopAskNotifying?.();
  // Local ends of any loopback sign-ins: plain HTTP servers on fixed ports,
  // exactly the kind of thing that must not outlive the app that opened them.
  stopAllSignInForwarders();
  stopSuggestionForwarding?.();
  stopTerminalForwarding?.();
  stopBrowserForwarding?.();
  stopExtensionRunCleanup?.();
  stopBrowserRunCleanup?.();
  stopPlanUsagePolling?.();
  stopUpdater?.();
  // Before the race below, and not part of it: an open listener keeps the port
  // bound, and a user who quits Artemis and relaunches it must not meet
  // "address already in use" from the copy that is exiting. `dispose` drops
  // live connections rather than waiting for clients to hang up.
  void serverHost?.dispose();
  // The bridge holds a bound loopback port, for the reason the server host's
  // dispose is here: relaunching must not meet "address already in use" from
  // the copy that is exiting, and the extension would be dialling a port held
  // by a dead process.
  void extensionBridge?.dispose();
  // And stop answering servers. Each relay client holds an open event stream
  // to a serving machine; a quit that left them would leave sockets to other
  // people's computers behind a process that is exiting.
  setBrowserRelayClient(null);
  // Stops the minute tick and flushes the ledger's write chain, so the firing
  // the user just watched is on disk before the process exits.
  void routineHost?.dispose();
  ipcLayer?.dispose();
  // Synchronous, and before the race below: a shell is a child of *this*
  // process, so anything still alive when `app.exit` fires is reparented to
  // init and keeps running with nothing to attach to it. Unlike the engine's
  // adapters there is nothing to shut down gracefully — the tab is already
  // gone — so this does not need a place in the timeout.
  terminals?.disposeAll();
  // Same argument as the shells above, for a different reason: a browser view
  // is a renderer process of this app's own, and one still attached to a window
  // that is being torn down is a crash on the way out rather than a leak.
  browsers.disposeAll();
  // Granted previews are byte snapshots held in this process's memory, and the
  // preview protocol handler stays registered for the up-to-three seconds the
  // engine gets below. Dropping the grants here makes "the app is quitting"
  // also mean "no preview is servable any more" — the teardown half that
  // `clearPreviews` was written for.
  clearPreviews();

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
  void Promise.race([engineHost.stop(), timeout]).finally(() => {
    app.exit(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Last-resort error handling                                                 */
/* -------------------------------------------------------------------------- */

// These log through `./log.ts`, which scrubs credential-shaped strings out of
// messages and stacks. An unhandled provider error can easily carry an
// `Authorization` header in its stack; it must not reach a terminal or a crash
// report verbatim.
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception in the main process', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection in the main process', reason);
});
