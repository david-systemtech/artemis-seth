/**
 * The browsers this Artemis has paired with, and what they may do.
 * ============================================================================
 *
 * One file under the app's userData, holding one record per paired browser and
 * the {@link PagePolicy} they all share. It is written the way every other
 * credential-bearing store in this process is written — a temporary file at
 * mode `0600`, then a rename — because the alternative is a half-written
 * document, and a half-written document here means a browser that can no
 * longer prove who it is and a user who has to pair again with no idea why.
 *
 * ## Why the secret is here and not in `safeStorage`
 *
 * `profileSecrets.ts` encrypts its values through Electron's `safeStorage`,
 * which on a desktop means the OS keychain. This store does not, and the
 * difference is what the secret *is*. A provider credential is a bearer token
 * for somebody's account on somebody else's servers: it is worth stealing on
 * its own, and it outlives the machine. A pairing secret is worth exactly one
 * thing — proving to this Artemis, on this machine, that the browser on the
 * other end of a loopback socket is the browser the user paired. An attacker
 * who can read this file can read the extension's own copy of the same value
 * out of the user's Chrome profile, and can read the transcripts and the
 * provider config directories sitting beside it. Encrypting it would protect
 * against nothing that is not already lost, at the cost of a store that fails
 * on any machine where `safeStorage` is unavailable — which is where a
 * headless CI run and a fresh Linux session both live.
 *
 * What *is* load-bearing is that the value never leaves main. The renderer is
 * given {@link PairedBrowserInfo}, which has no field for it; `redact.ts`
 * scans every IPC reply on the way out; and nothing logs it. See
 * {@link PairedBrowsers.info}.
 *
 * ## A missing or unreadable file is an empty store
 *
 * Not an error, on the same reasoning `profileSecrets.ts` gives: the first run
 * has no file, and a truncated one is a thing to recover from rather than to
 * refuse to start over. The cost of being wrong is that the user pairs again,
 * which is thirty seconds; the cost of throwing is an app that will not open.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DEFAULT_PAGE_POLICY,
  type PagePolicy,
  type PairedBrowserInfo,
} from '@rx-artemis/protocol';

import { createLogger } from './log.js';

const log = createLogger('paired-browsers');

/** Beside `profiles.json` and `profile-keys.json`, and named for its contents. */
const STORE_FILE = 'paired-browsers.json';

/**
 * One paired browser, as main holds it.
 *
 * The superset of {@link PairedBrowserInfo}: everything the renderer is shown,
 * plus the one field it is not.
 */
export interface PairedBrowser {
  readonly browserId: string;
  /** 32 random bytes, hex. Never logged, never sent to a renderer. */
  readonly secret: string;
  readonly browserName: string;
  readonly pairedAt: number;
  readonly extensionVersion?: string;
  readonly lastSeenAt?: number;
}

/** The document on disk. */
interface StoreDocument {
  readonly browsers: readonly PairedBrowser[];
  readonly policy: PagePolicy;
}

/** What the bridge asks of its store. */
export interface PairedBrowsers {
  /** Every paired browser, oldest pairing first. Includes secrets. */
  all(): readonly PairedBrowser[];
  /** One browser by id, or `null`. Includes its secret. */
  find(browserId: string): PairedBrowser | null;
  /** Record a new pairing. */
  add(browser: PairedBrowser): Promise<void>;
  /** Forget one. Answers whether there was one to forget. */
  remove(browserId: string): Promise<boolean>;
  /**
   * Note that a browser connected, with the extension version it reported.
   *
   * Separate from {@link add} because it happens on every connection and
   * changes nothing a user chose. Written to disk so that "this extension is
   * out of date" survives a restart of Artemis with Chrome closed.
   */
  noteSeen(browserId: string, extensionVersion: string, at: number): Promise<void>;
  /** The page policy every paired browser is held to. */
  policy(): PagePolicy;
  /** Replace the policy. */
  setPolicy(policy: PagePolicy): Promise<void>;
}

/**
 * Open the store, reading what is there.
 *
 * Async because the read is, and the bridge is started before any window
 * exists precisely so this has finished by the time a pane asks.
 */
export async function openPairedBrowsers(userDataDir: string): Promise<PairedBrowsers> {
  const file = join(userDataDir, STORE_FILE);
  let document = await read(file);

  async function save(next: StoreDocument): Promise<void> {
    document = next;
    const temporary = `${file}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      // In memory the change has happened, and the bridge has already acted on
      // it. Saying so and carrying on is better than unwinding a pairing the
      // browser has already been told about: the worst case is a pairing the
      // user has to redo after a restart, which is what they are doing now.
      log.error(`Could not write ${STORE_FILE}`, error);
    }
  }

  return {
    all: () => document.browsers,

    find: (browserId) => document.browsers.find((one) => one.browserId === browserId) ?? null,

    add: async (browser) => {
      await save({
        ...document,
        browsers: [...document.browsers.filter((one) => one.browserId !== browser.browserId), browser],
      });
    },

    remove: async (browserId) => {
      const kept = document.browsers.filter((one) => one.browserId !== browserId);
      if (kept.length === document.browsers.length) return false;
      await save({ ...document, browsers: kept });
      return true;
    },

    noteSeen: async (browserId, extensionVersion, at) => {
      const found = document.browsers.find((one) => one.browserId === browserId);
      if (found === undefined) return;
      if (found.extensionVersion === extensionVersion && found.lastSeenAt === at) return;
      await save({
        ...document,
        browsers: document.browsers.map((one) =>
          one.browserId === browserId ? { ...one, extensionVersion, lastSeenAt: at } : one,
        ),
      });
    },

    policy: () => document.policy,

    setPolicy: async (policy) => {
      await save({ ...document, policy });
    },
  };
}

/** What the renderer is told about a browser: everything but the secret. */
export function info(browser: PairedBrowser, connected: boolean): PairedBrowserInfo {
  return {
    browserId: browser.browserId,
    browserName: browser.browserName,
    pairedAt: browser.pairedAt,
    connected,
    ...(browser.extensionVersion === undefined
      ? {}
      : { extensionVersion: browser.extensionVersion }),
    ...(browser.lastSeenAt === undefined ? {} : { lastSeenAt: browser.lastSeenAt }),
  };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

const EMPTY: StoreDocument = { browsers: [], policy: DEFAULT_PAGE_POLICY };

async function read(file: string): Promise<StoreDocument> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return EMPTY;
    const raw = parsed as { browsers?: unknown; policy?: unknown };
    return {
      browsers: Array.isArray(raw.browsers)
        ? raw.browsers.map(readBrowser).filter((one): one is PairedBrowser => one !== null)
        : [],
      policy: readPolicy(raw.policy),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`Could not read ${STORE_FILE}; treating it as empty.`, error);
    }
    return EMPTY;
  }
}

/**
 * One record, or `null` for anything that is not plainly one.
 *
 * Dropped rather than repaired. A record missing its secret cannot
 * authenticate anybody, and one whose id is a number would be compared against
 * a string for ever without matching; both are a browser that has to be paired
 * again, and the honest way to say that is to not be in the list.
 */
function readBrowser(value: unknown): PairedBrowser | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const browserId = raw['browserId'];
  const secret = raw['secret'];
  const browserName = raw['browserName'];
  const pairedAt = raw['pairedAt'];
  if (typeof browserId !== 'string' || browserId.length === 0) return null;
  if (typeof secret !== 'string' || secret.length === 0) return null;
  if (typeof browserName !== 'string') return null;
  if (typeof pairedAt !== 'number' || !Number.isFinite(pairedAt)) return null;
  const extensionVersion = raw['extensionVersion'];
  const lastSeenAt = raw['lastSeenAt'];
  return {
    browserId,
    secret,
    browserName,
    pairedAt,
    ...(typeof extensionVersion === 'string' ? { extensionVersion } : {}),
    ...(typeof lastSeenAt === 'number' && Number.isFinite(lastSeenAt) ? { lastSeenAt } : {}),
  };
}

/**
 * The stored policy, field by field, defaulting anything unreadable.
 *
 * Field by field rather than all-or-nothing because the failure modes point
 * opposite ways: a `devSites` list that did not survive a hand edit should
 * become empty, which is the *safe* answer, while the two `…Everywhere`
 * switches should fall back to off for the same reason. Defaulting the whole
 * document because one list is malformed would silently un-block sites the
 * user had blocked.
 */
function readPolicy(value: unknown): PagePolicy {
  if (typeof value !== 'object' || value === null) return DEFAULT_PAGE_POLICY;
  const raw = value as Record<string, unknown>;
  return {
    devSites: hosts(raw['devSites']),
    blockedSites: hosts(raw['blockedSites']),
    unblockedSites: hosts(raw['unblockedSites']),
    evaluateEverywhere: raw['evaluateEverywhere'] === true,
    deepReadEverywhere: raw['deepReadEverywhere'] === true,
  };
}

function hosts(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((one): one is string => typeof one === 'string' && one.length > 0);
}
