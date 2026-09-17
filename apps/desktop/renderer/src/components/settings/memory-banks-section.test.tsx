/**
 * @vitest-environment jsdom
 *
 * The Memory Banks pane, and the property this phase was about: **joining a
 * team bank from your own git URL is possible.**
 *
 * Three things used to make it impossible, and all three are behavioural
 * rather than visual, so they are what is pinned here:
 *
 *  - **The submit button was gated on the whole machine.** `doctor` answers
 *    for a destination directory, a `PATH` shim and — before any bank exists —
 *    reachability of *this project's own* upstream, which is a private repo an
 *    outside user can only fail. Any one of those turned off the button that
 *    joins a bank none of them are about. Now the gate is per mode, and a
 *    failing check outside the mode's list still renders while blocking
 *    nothing.
 *  - **A failed preflight read rendered as "Checking…", forever.** The hook
 *    coerced the error to `null`, which is also what "still loading" looks
 *    like. On Windows — where the read fails with "Python 3 is required" —
 *    that sentence was the whole of what the user was told.
 *  - **There was nowhere to put a token, and no way to try a URL** short of
 *    committing to a clone that takes minutes to fail.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { act } from 'react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type {
  IpcResult,
  MemoryBankCheck,
  MemoryBankInfo,
  MemoryBankMemory,
  MemoryBankPreflight,
  MemoryBankSetProfilesRequest,
  MemoryBankVerifyRemoteRequest,
  MemoryBankVerifyRemoteResponse,
  MemoryBankWireClaudeCodeRequest,
  MemoryBanksStatus,
  SecretConnectionState,
  ServerMemoryBank,
  ServerMemoryBanksSetProfilesRequest,
  SecretProviderDescriptor,
  SecretRefTestResult,
  SecretsRefTestRequest,
} from '@rx-artemis/protocol';

import { MemoryBankGroups, slugFromRemote } from '@/components/settings/MemoryBanksSection';
import { useMemoryBanks } from '@/hooks/useMemoryBanks';
import { seedApp } from '@/state/testkit';
import { TooltipProvider } from '@/components/ui/tooltip';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

/**
 * The one store action this pane calls.
 *
 * Mocked rather than exercised: what it does — split a column, move its
 * directory, close this dialog, send — is pinned in `state/describeBank.test.ts`
 * against the real store, and what the card owes is only that it calls it, with
 * the four facts the prompt is composed from.
 */
const describeMemoryBank = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@/state/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/state/store')>()),
  describeMemoryBank,
}));

const ok = <T,>(value: T) => ({ ok: true as const, value });

/** A machine with nothing set up yet — the state onboarding actually happens in. */
const NO_BANKS: MemoryBanksStatus = {
  cliAvailable: true,
  masterEnabled: false,
  banks: [],
  profiles: [],
};

const check = (id: string, state: MemoryBankCheck['state']): MemoryBankCheck => ({
  id,
  label: id,
  state,
  detail: `${id} detail`,
  remedy: null,
});

/**
 * One configured bank, healthy, with everything the card draws.
 *
 * A builder rather than literals per test because the record grew a name, a
 * description, a format, a profile scope and a problems list, and a test that
 * spelled all of them out to assert on one of them would be five lines of
 * noise around the line that matters.
 */
const bank = (over: Partial<MemoryBankInfo> = {}): MemoryBankInfo => ({
  slug: 'team',
  name: 'team',
  description: null,
  format: 'manifest',
  profiles: { kind: 'all' },
  problems: [],
  path: '/Users/demo/Documents/team',
  remote: 'https://git.example.com/team/bank.git',
  role: 'readwrite',
  enabled: true,
  isDefault: true,
  exists: true,
  source: 'cerebro@52a0a32',
  memories: 3,
  mirrored: 0,
  validationErrors: 0,
  projects: 2,
  embedsCli: true,
  ...over,
});

/** One entry in a bank, as the browser reads it. */
const memory = (over: Partial<MemoryBankMemory> = {}): MemoryBankMemory => ({
  name: 'a-fact',
  title: 'A fact',
  type: 'reference',
  description: 'Something durable',
  body: 'The body of the memory.',
  added: '2026-09-15',
  author: 'demo@example.com',
  org: null,
  project: null,
  scope: {},
  problems: [],
  readonly: false,
  file: 'memories/a-fact.md',
  ...over,
});

/** The two accounts the profile picker draws its rows from. */
const PROFILES = [
  { id: 'work', label: 'Work', providerId: 'claude', configDir: '/home/u/.work' },
  { id: 'side', label: 'Side', providerId: 'codex', configDir: '/home/u/.side' },
];

/** Every check green — the baseline the gating tests vary one row from. */
const HEALTHY: MemoryBankPreflight = {
  ready: true,
  checks: [check('python', 'ok'), check('git', 'ok'), check('git-identity', 'ok'), check('repo', 'ok')],
};

let preflight: IpcResult<MemoryBankPreflight> = ok(HEALTHY);
let status: MemoryBanksStatus = NO_BANKS;
let verifyAnswer: MemoryBankVerifyRemoteResponse = {
  outcome: 'ok',
  headPresent: true,
  detail: 'HEAD is 52a0a327',
};
const verifyCalls: MemoryBankVerifyRemoteRequest[] = [];
const addCalls: unknown[] = [];
const profileCalls: MemoryBankSetProfilesRequest[] = [];
const wireCalls: MemoryBankWireClaudeCodeRequest[] = [];
/** Entries the next `memories` read answers with, per slug. */
let bankMemories: readonly MemoryBankMemory[] = [];

/* -------------------------------------------------------------------------- */
/* The banks on an Artemis Server                                             */
/* -------------------------------------------------------------------------- */

/**
 * A server carrying two banks, one of each scope.
 *
 * Both branches of the picker — the "every account" tick and the checklist
 * under it — are reachable without a test having to click one into existence,
 * and the ids are deliberately unlike the local profiles' so a test that
 * confused the two registries could not pass by accident.
 */
const SERVER_ACCOUNTS = [
  { id: 'acct-1', slug: 'remote-work', label: 'Remote work' },
  { id: 'acct-2', slug: 'remote-side', label: 'Remote side' },
];

const SERVER_BANKS: readonly ServerMemoryBank[] = [
  {
    slug: 'cortex',
    path: '/data/banks/cortex',
    role: 'readwrite',
    enabled: true,
    profiles: { kind: 'all' },
  },
  {
    slug: 'client-notes',
    path: '/data/banks/client-notes',
    role: 'readonly',
    enabled: true,
    profiles: { kind: 'profiles', profileIds: ['acct-1'] },
  },
];

let serverBanks: readonly ServerMemoryBank[] = SERVER_BANKS;
/** False is every reason a server has nothing to offer here. See the group. */
let serverBanksAvailable = true;
const serverScopeCalls: ServerMemoryBanksSetProfilesRequest[] = [];

/* -------------------------------------------------------------------------- */
/* The key managers this machine has                                          */
/* -------------------------------------------------------------------------- */

/**
 * Two connections, one of each provider, because the reference form is built
 * from the provider's declared fields — and a fixture with one provider would
 * let that stop being true without any test noticing.
 */
const CONNECTIONS: readonly SecretConnectionState[] = [
  {
    connection: {
      id: 'sec-1',
      label: 'Work vault',
      provider: 'openbao',
      address: 'https://vault.example.com:8200',
      authMethod: 'userpass',
      username: 'demo',
    },
    hasCredential: true,
    lastVerify: null,
  },
  {
    connection: {
      id: 'sec-2',
      label: 'Team Doppler',
      provider: 'doppler',
      address: 'https://api.doppler.com',
      authMethod: 'token',
    },
    hasCredential: true,
    lastVerify: null,
  },
];

const SECRET_PROVIDERS: readonly SecretProviderDescriptor[] = [
  {
    id: 'openbao',
    label: 'OpenBao',
    note: 'Self-hosted.',
    authMethods: ['userpass', 'token'],
    configFields: [],
    refFields: [
      { id: 'mount', label: 'Mount', required: true, kind: 'text' },
      { id: 'path', label: 'Path', required: true, kind: 'text' },
      { id: 'key', label: 'Key', required: true, kind: 'text' },
    ],
  },
  {
    id: 'doppler',
    label: 'Doppler',
    note: 'Hosted.',
    authMethods: ['token'],
    configFields: [],
    refFields: [{ id: 'name', label: 'Secret', required: true, kind: 'text' }],
  },
];

let connections: readonly SecretConnectionState[] = CONNECTIONS;
let refTestAnswer: SecretRefTestResult = { found: true, keysAtPath: ['git_token', 'username'] };
const testRefCalls: SecretsRefTestRequest[] = [];

/** Installed before the first render: `resolveBridge` memoises on first use. */
(globalThis.window as unknown as { artemis: unknown }).artemis = {
  secrets: {
    listConnections: async () => ok({ connections, providers: SECRET_PROVIDERS }),
    saveConnection: async () => ok({ connections, providers: SECRET_PROVIDERS, id: 'sec-1', verify: { ok: true, detail: '' } }),
    deleteConnection: async () => ok({ connections, providers: SECRET_PROVIDERS }),
    verifyConnection: async () => ok({ connections, providers: SECRET_PROVIDERS, verify: { ok: true, detail: '' } }),
    fetchServerCert: async () => ({ ok: false, error: { code: 'internal', message: 'not in this test', retryable: false } }),
    testRef: async (request: SecretsRefTestRequest) => {
      testRefCalls.push(request);
      return ok(refTestAnswer);
    },
  },
  memoryBanks: {
    status: async () => ok(status),
    preflight: async () => preflight,
    memories: async () => ok({ memories: bankMemories }),
    verifyRemote: async (request: MemoryBankVerifyRemoteRequest) => {
      verifyCalls.push(request);
      return ok(verifyAnswer);
    },
    add: async (request: unknown) => {
      addCalls.push(request);
      return ok({ message: 'Joined.' });
    },
    sync: async () => ok({ message: '' }),
    retire: async () => ok({ message: '' }),
    setEnabled: async () => ok({ message: '' }),
    setProfiles: async (request: MemoryBankSetProfilesRequest) => {
      profileCalls.push(request);
      return ok({ message: 'Attached.' });
    },
    wireClaudeCode: async (request: MemoryBankWireClaudeCodeRequest) => {
      wireCalls.push(request);
      return ok({ message: 'Wired.' });
    },
    forget: async () => ok({ message: '' }),
    setMasterEnabled: async () => ok({ message: '' }),
  },
  serverMemoryBanks: {
    list: async () =>
      ok({
        manageProfiles: true,
        available: serverBanksAvailable,
        banks: serverBanksAvailable ? serverBanks : [],
        accounts: serverBanksAvailable ? SERVER_ACCOUNTS : [],
      }),
    setProfiles: async (request: ServerMemoryBanksSetProfilesRequest) => {
      serverScopeCalls.push(request);
      serverBanks = serverBanks.map((entry) =>
        entry.slug === request.slug ? { ...entry, profiles: request.profiles } : entry,
      );
      const changed = serverBanks.find((entry) => entry.slug === request.slug);
      return ok({ bank: changed as ServerMemoryBank });
    },
  },
};

/*
 * The banks half of the Instructions pane, wired the way `InstructionsSection`
 * wires it: one `useMemoryBanks` in the parent, threaded down as a prop. The
 * groups are rendered without the prompts half so that a failure here is about
 * the banks and not about the agent-prompts channel this file does not stub.
 */
function BanksHalf(): ReactElement {
  return <MemoryBankGroups pane={useMemoryBanks()} />;
}

async function renderPane(): Promise<void> {
  render(
    <TooltipProvider>
      <BanksHalf />
    </TooltipProvider>,
  );
  await act(async () => {});
}

/** Fill in the two fields a join needs, so only the gating is under test. */
function fillJoin(remote = 'https://git.example.com/team/bank.git'): void {
  fireEvent.change(screen.getByLabelText('Bank slug'), { target: { value: 'team' } });
  fireEvent.change(screen.getByLabelText('Bank remote URL'), { target: { value: remote } });
}

const joinButton = (): HTMLElement => screen.getByRole('button', { name: 'Join bank' });

beforeEach(() => {
  preflight = ok(HEALTHY);
  status = NO_BANKS;
  verifyAnswer = { outcome: 'ok', headPresent: true, detail: 'HEAD is 52a0a327' };
  connections = CONNECTIONS;
  refTestAnswer = { found: true, keysAtPath: ['git_token', 'username'] };
  bankMemories = [];
  serverBanks = SERVER_BANKS;
  serverBanksAvailable = true;
  seedApp({ profiles: PROFILES as never });
});

afterEach(() => {
  cleanup();
  verifyCalls.length = 0;
  addCalls.length = 0;
  testRefCalls.length = 0;
  profileCalls.length = 0;
  wireCalls.length = 0;
  serverScopeCalls.length = 0;
  describeMemoryBank.mockClear();
});

describe('joining a private bank', () => {
  it('offers a token field and a way to check the URL before committing to it', async () => {
    await renderPane();
    expect(screen.getByLabelText(/Access token/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Verify' })).toBeTruthy();
  });

  it('masks the token, and keeps it out of autofill', async () => {
    await renderPane();
    const field = screen.getByLabelText(/Access token/) as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('off');
  });

  it('keeps the username behind a toggle, with the hosts that need one named', async () => {
    // Almost nobody has to touch it — GitHub, Forgejo and Gitea ignore the
    // field entirely — so it is collapsed rather than a fourth input to read
    // past. The hosts that do need it are named where it opens.
    await renderPane();
    expect(screen.queryByLabelText('Username')).toBeNull();

    await act(async () => {
      screen.getByRole('button', { name: /Username/ }).click();
    });
    expect(screen.getByLabelText('Username')).toBeTruthy();
    expect(screen.getByText(/GitLab deploy token/)).toBeTruthy();
  });

  it('offers none of that for a local bank, which has no remote to authenticate to', async () => {
    await renderPane();
    await act(async () => {
      screen.getByRole('button', { name: 'Create local' }).click();
    });
    expect(screen.queryByLabelText(/Access token/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
  });

  it('sends the token with the join, and only with the join', async () => {
    await renderPane();
    fillJoin();
    fireEvent.change(screen.getByLabelText(/Access token/), { target: { value: 'glpat-secret' } });

    await act(async () => {
      joinButton().click();
    });

    expect(addCalls).toEqual([
      {
        mode: 'join',
        slug: 'team',
        role: 'readwrite',
        remote: 'https://git.example.com/team/bank.git',
        auth: { token: 'glpat-secret' },
      },
    ]);
  });

  it('clears the token once the bank is joined', async () => {
    // Main has stored it encrypted by now. A copy left in a mounted form is a
    // copy nothing needs.
    await renderPane();
    fillJoin();
    fireEvent.change(screen.getByLabelText(/Access token/), { target: { value: 'glpat-secret' } });
    await act(async () => {
      joinButton().click();
    });
    expect((screen.getByLabelText(/Access token/) as HTMLInputElement).value).toBe('');
  });
});

describe('verifying a remote', () => {
  it('is disabled until the URL parses, and asks about that URL', async () => {
    await renderPane();
    expect(screen.getByRole('button', { name: 'Verify' }).hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByLabelText('Bank remote URL'), {
      target: { value: 'https://git.example.com/team/bank.git' },
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });

    // Enabled on a URL alone — no slug, no preflight, no other field.
    expect(verifyCalls).toEqual([{ remote: 'https://git.example.com/team/bank.git' }]);
  });

  it('reports a reachable remote', async () => {
    await renderPane();
    fillJoin();
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });
    expect(screen.getByText(/can read it/)).toBeTruthy();
    expect(screen.getByText('HEAD is 52a0a327')).toBeTruthy();
  });

  it('reports an empty repository as reachable, because it is a bank to join', async () => {
    verifyAnswer = { outcome: 'ok', headPresent: false, detail: 'readable, and empty' };
    await renderPane();
    fillJoin();
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });
    expect(screen.getByText(/Reachable, and empty/)).toBeTruthy();
  });

  it('suggests a token when the remote asks for credentials', async () => {
    // Amber, and worded as one more thing to supply: nothing is wrong here.
    verifyAnswer = {
      outcome: 'auth-required',
      headPresent: false,
      detail: "fatal: could not read Username for 'https://git.example.com'",
    };
    await renderPane();
    fillJoin();
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });
    expect(screen.getByText(/add an access token/)).toBeTruthy();
    expect(screen.getByText(/could not read Username/)).toBeTruthy();
  });

  it('separates a repository that is not there from a host that will not answer', async () => {
    verifyAnswer = { outcome: 'not-found', headPresent: false, detail: 'remote: Repository not found.' };
    await renderPane();
    fillJoin();
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });
    expect(screen.getByText(/No repository there/)).toBeTruthy();
    expect(screen.getByText('remote: Repository not found.')).toBeTruthy();

    verifyAnswer = { outcome: 'unreachable', headPresent: false, detail: 'Could not resolve host' };
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });
    expect(screen.getByText(/Could not reach the remote/)).toBeTruthy();
  });

  it('drops the result when the URL it was about changes', async () => {
    await renderPane();
    fillJoin();
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });
    expect(screen.getByText(/can read it/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Bank remote URL'), {
      target: { value: 'https://git.example.com/team/other.git' },
    });
    expect(screen.queryByText(/can read it/)).toBeNull();
  });
});

describe('what actually blocks the button', () => {
  it('joins with a failing check that has nothing to do with joining', async () => {
    // `repo` is about a destination directory a join does not use, and
    // `python` is about a CLI nothing on this path runs any more — Artemis
    // reads the banks itself. Neither is a reason to refuse the button.
    preflight = ok({
      ready: false,
      checks: [check('git', 'ok'), check('python', 'fail'), check('repo', 'fail')],
    });
    await renderPane();
    fillJoin();

    expect(joinButton().hasAttribute('disabled')).toBe(false);
    // The rows are still on screen — they are the machine's honest condition —
    // marked as not standing in the way.
    expect(screen.getAllByText('not needed to join').length).toBe(2);
  });

  it('refuses to join without git, which a join genuinely cannot do without', async () => {
    preflight = ok({ ready: false, checks: [check('git', 'fail'), check('python', 'ok')] });
    await renderPane();
    fillJoin();

    expect(joinButton().hasAttribute('disabled')).toBe(true);
    // The row that did it is marked, and the hint below the button says which
    // mark to look for — a disabled button with no explanation is the thing
    // this pane spent its first version being.
    expect(screen.getAllByText('required').length).toBeGreaterThan(0);
    expect(screen.getByText(/Fix the requirements marked/)).toBeTruthy();
  });

  it('still refuses to create a bank with no git identity, because creating commits', async () => {
    // The same failed check gates the two modes differently, which is the
    // whole point of a per-mode list: joining is a clone, creating is a commit
    // — of the BANK.md the bank starts from.
    preflight = ok({ ready: false, checks: [check('git', 'ok'), check('git-identity', 'fail')] });
    await renderPane();
    fillJoin();
    expect(joinButton().hasAttribute('disabled')).toBe(false);

    await act(async () => {
      screen.getByRole('button', { name: 'Create local' }).click();
    });
    expect(screen.getByRole('button', { name: 'Create bank' }).hasAttribute('disabled')).toBe(true);
  });

  it('adopts a folder on a machine that can do nothing else', async () => {
    // Adopting writes nothing and clones nothing: it registers a directory
    // that already is a bank. No git, no identity, and it is still a legal
    // thing to ask for — which is why its blocking list is empty.
    preflight = ok({
      ready: false,
      checks: [check('git', 'fail'), check('git-identity', 'fail'), check('python', 'fail')],
    });
    await renderPane();
    await act(async () => {
      screen.getByRole('button', { name: 'Adopt a folder' }).click();
    });
    fireEvent.change(screen.getByLabelText('Bank slug'), { target: { value: 'team' } });
    fireEvent.change(screen.getByLabelText('Bank path'), { target: { value: '/Users/demo/team' } });

    expect(screen.getByRole('button', { name: 'Adopt bank' }).hasAttribute('disabled')).toBe(false);
  });

  it('blocks all three modes in a window driving another machine', async () => {
    // `remote` is the synthetic row `remoteBridge` answers the preflight with.
    // The banks are on the serving machine and managed there, so every button
    // has to be off — the version that left Join enabled produced a click
    // whose only result was `add` refusing.
    preflight = ok({
      ready: false,
      checks: [
        {
          id: 'remote',
          label: 'Remote connection',
          state: 'fail',
          detail: 'Memory banks live on the serving machine and are managed there.',
          remedy: null,
        },
      ],
    });
    await renderPane();
    fillJoin();
    expect(joinButton().hasAttribute('disabled')).toBe(true);

    await act(async () => {
      screen.getByRole('button', { name: 'Create local' }).click();
    });
    expect(screen.getByRole('button', { name: 'Create bank' }).hasAttribute('disabled')).toBe(true);

    await act(async () => {
      screen.getByRole('button', { name: 'Adopt a folder' }).click();
    });
    expect(screen.getByRole('button', { name: 'Adopt bank' }).hasAttribute('disabled')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The bank card                                                              */
/* -------------------------------------------------------------------------- */

describe('a bank card', () => {
  const withBanks = (...banks: readonly MemoryBankInfo[]): void => {
    status = { ...NO_BANKS, masterEnabled: true, banks };
  };

  it('says how the bank is kept, in the words of the thing on disk', async () => {
    // The format decides what everything else on the card means, so it is a
    // badge rather than a fact row: a manifest bank describes its own layout,
    // the two legacy ones are read with the shapes the CLI baked in.
    withBanks(
      bank({ slug: 'manifest-bank', format: 'manifest' }),
      bank({ slug: 'projects-bank', format: 'legacy-projects', isDefault: false }),
      bank({ slug: 'flat-bank', format: 'legacy-flat', isDefault: false }),
      bank({ slug: 'empty-dir', format: null, isDefault: false }),
    );
    await renderPane();

    expect(screen.getByText('BANK.md')).toBeTruthy();
    expect(screen.getByText('cerebro · by project')).toBeTruthy();
    expect(screen.getByText('cerebro · flat')).toBeTruthy();
    // Not a format at all — a registered directory that holds no bank, which
    // is a condition and is drawn as one.
    expect(screen.getByText('not a bank')).toBeTruthy();
  });

  it('shows the bank’s own name and description, and prints the name once', async () => {
    withBanks(
      bank({ slug: 'cortex', name: 'Cortex', description: 'Everything the homelab has learned.' }),
    );
    await renderPane();

    expect(screen.getByText('Cortex')).toBeTruthy();
    expect(screen.getByText('Everything the homelab has learned.')).toBeTruthy();

    cleanup();
    // A bank that calls itself after its slug says it once, not twice.
    withBanks(bank({ slug: 'cortex', name: 'cortex' }));
    await renderPane();
    expect(screen.getAllByText('cortex')).toHaveLength(1);
  });

  it('no longer offers to wire profiles, because there are no blocks to repair', async () => {
    // The drift-repair button existed for the CLI's managed CLAUDE.md blocks,
    // which are stock Claude Code's path and not Artemis's any more. What
    // "which profiles" means now is the picker below it.
    withBanks(bank());
    await renderPane();
    expect(screen.queryByRole('button', { name: 'Wire profiles' })).toBeNull();
  });

  it('attaches the bank to every profile, or to the ones ticked', async () => {
    withBanks(bank({ profiles: { kind: 'all' } }));
    await renderPane();

    // Narrowing hands back every profile ticked, so the act of narrowing does
    // not itself detach the bank from everything.
    await act(async () => {
      screen.getByLabelText('Attach “team” to every profile').click();
    });
    expect(profileCalls).toEqual([
      { slug: 'team', profiles: { kind: 'profiles', profileIds: ['work', 'side'] } },
    ]);
  });

  it('ticks and unticks one profile at a time', async () => {
    withBanks(bank({ profiles: { kind: 'profiles', profileIds: ['work'] } }));
    await renderPane();

    // The per-profile rows are only there once "every profile" is off, which
    // is the state this bank is already in.
    expect(screen.getByLabelText('Attach “team” to Work').getAttribute('data-state')).toBe('checked');
    expect(screen.getByLabelText('Attach “team” to Side').getAttribute('data-state')).toBe('unchecked');

    await act(async () => {
      screen.getByLabelText('Attach “team” to Side').click();
    });
    expect(profileCalls).toEqual([
      { slug: 'team', profiles: { kind: 'profiles', profileIds: ['work', 'side'] } },
    ]);

    profileCalls.length = 0;
    await act(async () => {
      screen.getByLabelText('Attach “team” to Work').click();
    });
    expect(profileCalls).toEqual([
      { slug: 'team', profiles: { kind: 'profiles', profileIds: [] } },
    ]);
  });

  it('hides the per-profile list behind "every profile"', async () => {
    withBanks(bank({ profiles: { kind: 'all' } }));
    await renderPane();
    expect(screen.queryByLabelText('Attach “team” to Work')).toBeNull();
  });
  it('folds what the reader refused, with the count on the summary', async () => {
    withBanks(
      bank({
        validationErrors: 2,
        problems: [
          'memories/a/b/one.md: metadata.type is missing',
          'memories/a/b/two.md: body exceeds 6000 characters',
        ],
      }),
    );
    await renderPane();

    // Folded: on a healthy bank it is nothing, and on a broken one it would
    // bury every other fact on the card. The count is on the summary so a
    // person can see there is something to open without opening it.
    expect(screen.getByText('2 entries have problems')).toBeTruthy();
    expect(screen.queryByText(/metadata.type is missing/)).toBeNull();

    await act(async () => {
      screen.getByText('2 entries have problems').click();
    });
    expect(screen.getByText(/metadata.type is missing/)).toBeTruthy();
    expect(screen.getByText(/body exceeds 6000 characters/)).toBeTruthy();
  });

  it('says nothing about problems when there are none', async () => {
    withBanks(bank());
    await renderPane();
    expect(screen.queryByText(/entries have problems/)).toBeNull();
  });
});

/**
 * The banks on an Artemis Server, and the accounts *there* each one reaches.
 *
 * The pane's second registry. A server wears every one of its accounts behind
 * a single local profile, so the checklist above — which ticks this machine's
 * profiles — could never name them, and until this group existed the only
 * thing that could set a served bank's scope was a text editor on the serving
 * machine. What is pinned here is that the rows are the *server's* accounts,
 * that a tick sends the server's own ids, and that a server with nothing to
 * say renders nothing rather than an error.
 */
describe('banks on an Artemis Server', () => {
  /** The local profile that *is* the server, beside the two local ones. */
  const WITH_SERVER = [
    ...PROFILES,
    { id: 'srv', label: 'Big Iron', providerId: 'artemis', configDir: '/home/u/.srv' },
  ];

  it('lists the server\'s banks with the server\'s own accounts to tick', async () => {
    seedApp({ profiles: WITH_SERVER as never });
    await renderPane();

    expect(screen.getByText('Banks on Big Iron (2)')).toBeTruthy();
    // The scoped bank's rows are the server's accounts, not this machine's.
    expect(screen.getByLabelText('Attach “client-notes” to Remote work')).toBeTruthy();
    expect(screen.queryByLabelText('Attach “client-notes” to Work')).toBeNull();
  });

  it('sends the server\'s own account ids when a bank is narrowed', async () => {
    seedApp({ profiles: WITH_SERVER as never });
    await renderPane();

    await act(async () => {
      screen.getByLabelText('Attach “cortex” to every account on this server').click();
    });
    expect(serverScopeCalls).toEqual([
      {
        profileId: 'srv',
        slug: 'cortex',
        profiles: { kind: 'profiles', profileIds: ['acct-1', 'acct-2'] },
      },
    ]);
  });

  it('draws what the server answered, not what was clicked', async () => {
    // A checkbox that moved because it was clicked rather than because the
    // write landed would show a scope the server does not have.
    seedApp({ profiles: WITH_SERVER as never });
    await renderPane();

    await act(async () => {
      screen.getByLabelText('Attach “client-notes” to Remote side').click();
    });
    expect(
      screen.getByLabelText('Attach “client-notes” to Remote side').getAttribute('data-state'),
    ).toBe('checked');
  });

  it('renders nothing for a machine with no server, and for a server with nothing to say', async () => {
    // No Artemis-Server profile at all.
    await renderPane();
    expect(screen.queryByText(/^Banks on /)).toBeNull();
    cleanup();

    // A server too old for the surface, one with no registry, and a token
    // without the grant all arrive as `available: false`, and all three mean
    // there is nothing here to edit.
    serverBanksAvailable = false;
    seedApp({ profiles: WITH_SERVER as never });
    await renderPane();
    expect(screen.queryByText(/^Banks on /)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The other harness                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Wiring a bank into stock Claude Code — the one thing on this pane that is
 * not about Artemis.
 *
 * Three properties, and they are the whole of the row. It reports what the
 * *files* say rather than what the pane remembers; it asks for the state it
 * wants rather than toggling; and a bank with no embedded CLI cannot do it at
 * all, which is a dimmed button with a sentence rather than a hidden one or a
 * click that fails.
 */
describe('wiring a bank into stock Claude Code', () => {
  const PROFILE_STATES = [
    { name: 'work', label: 'Work', hook: true, banks: { team: true } },
    { name: 'side', label: 'Side', hook: false, banks: { team: false } },
  ];

  const withBanks = (
    banks: readonly MemoryBankInfo[],
    profiles: MemoryBanksStatus['profiles'] = PROFILE_STATES,
  ): void => {
    status = { ...NO_BANKS, masterEnabled: true, banks, profiles };
  };

  const wireButton = (): HTMLElement =>
    screen.getByRole('button', { name: 'Wire for stock Claude Code' });

  it('says what the profiles carry, block count and hook', async () => {
    withBanks([bank()]);
    await renderPane();
    expect(screen.getByText(/Managed block in 1 of 2 profiles/)).toBeTruthy();
    expect(screen.getByText(/session-start sync hook installed/)).toBeTruthy();
  });

  it('says when no profile carries it, and offers to wire', async () => {
    withBanks([bank()], [{ name: 'work', label: 'Work', hook: false, banks: { team: false } }]);
    await renderPane();
    expect(screen.getByText(/Managed block in 0 of 1 profile /)).toBeTruthy();
    expect(screen.getByText(/session-start sync hook not installed/)).toBeTruthy();
    expect(wireButton()).toBeTruthy();
  });

  it('offers to unwire a bank some profile already carries', async () => {
    withBanks([bank()]);
    await renderPane();
    expect(screen.getByRole('button', { name: 'Unwire' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Wire for stock Claude Code' })).toBeNull();
  });

  it('asks for the state it wants, both ways', async () => {
    withBanks([bank()], [{ name: 'work', label: 'Work', hook: false, banks: { team: false } }]);
    await renderPane();
    await act(async () => {
      wireButton().click();
    });
    expect(wireCalls).toEqual([{ slug: 'team', enabled: true }]);

    wireCalls.length = 0;
    cleanup();
    withBanks([bank()]);
    await renderPane();
    await act(async () => {
      screen.getByRole('button', { name: 'Unwire' }).click();
    });
    expect(wireCalls).toEqual([{ slug: 'team', enabled: false }]);
  });

  it('refuses, with a reason, on a bank that embeds no CLI', async () => {
    // Not hidden: a bank with no `bin/cerebro` is perfectly healthy, and the
    // sentence is what keeps the dimmed button from reading as a fault.
    withBanks(
      [bank({ embedsCli: false })],
      [{ name: 'work', label: 'Work', hook: false, banks: { team: false } }],
    );
    await renderPane();

    const button = wireButton();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      button.click();
    });
    expect(wireCalls).toEqual([]);
  });

  it('says whose path this is, so nobody reads it as an Artemis setting', async () => {
    withBanks([bank()]);
    await renderPane();
    expect(screen.getByText(/Artemis's own runs need none of this/)).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Giving a bank a BANK.md                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The card's one route to a manifest.
 *
 * A `BANK.md` is not a form — nearly all of it is in the tree and the rest is a
 * conversation — so the card's whole obligation is to start that conversation
 * in the right checkout, and to say which of the two jobs it is starting.
 */
describe('describing a bank', () => {
  const withBanks = (...banks: readonly MemoryBankInfo[]): void => {
    status = { ...NO_BANKS, masterEnabled: true, banks };
  };

  const describeButton = (): HTMLElement =>
    screen.getByRole('button', { name: 'Describe this bank…' });

  it('offers to write a manifest for a bank that has none, whatever it is kept as', async () => {
    withBanks(
      bank({ slug: 'flat-bank', format: 'legacy-flat' }),
      bank({ slug: 'projects-bank', format: 'legacy-projects', isDefault: false }),
      // Not a format at all — a registered directory Artemis does not read as a
      // bank, which is the card most in need of this.
      bank({ slug: 'empty-dir', format: null, isDefault: false }),
    );
    await renderPane();

    expect(screen.getAllByRole('button', { name: 'Describe this bank…' })).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Revise BANK.md…' })).toBeNull();
  });

  it('offers to revise the manifest a bank already has', async () => {
    // Describing a bank that already describes itself would be proposing work
    // the user can see on the card is done.
    withBanks(bank({ format: 'manifest' }));
    await renderPane();

    expect(screen.getByRole('button', { name: 'Revise BANK.md…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Describe this bank…' })).toBeNull();
  });

  it('says what pressing it starts, on the card that needs telling', async () => {
    withBanks(bank({ format: null }));
    await renderPane();
    expect(
      screen.getByText(
        "Starts a conversation in the bank's checkout that reads the tree, proposes a BANK.md, asks you what it cannot infer, and lands it through the bank's review path.",
      ),
    ).toBeTruthy();

    cleanup();
    // A bank with a manifest keeps the button and drops the pitch.
    withBanks(bank({ format: 'manifest' }));
    await renderPane();
    expect(screen.queryByText(/Starts a conversation in the bank/)).toBeNull();
  });

  it('hands the store the four facts the prompt is composed from', async () => {
    withBanks(
      bank({
        slug: 'cortex',
        name: 'Cortex',
        path: '/Users/demo/Documents/cortex',
        format: 'legacy-projects',
      }),
    );
    await renderPane();

    await act(async () => {
      describeButton().click();
    });

    expect(describeMemoryBank).toHaveBeenCalledWith({
      slug: 'cortex',
      name: 'Cortex',
      path: '/Users/demo/Documents/cortex',
      format: 'legacy-projects',
    });
  });

  it('refuses on a bank that is not on disk, and names the path', async () => {
    // There is no tree to read and no directory to run in. Disabled with the
    // reason rather than hidden — `disabled-reason.tsx` has the house rule, and
    // the reason is why the button stays focusable instead of natively
    // `disabled`.
    withBanks(bank({ format: null, exists: false, path: '/Users/demo/gone' }));
    await renderPane();

    const button = describeButton();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);

    await act(async () => {
      button.click();
    });
    expect(describeMemoryBank).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* The memory browser                                                         */
/* -------------------------------------------------------------------------- */

describe('browsing a bank', () => {
  const open = async (): Promise<void> => {
    await act(async () => {
      screen.getByText('memories').click();
    });
  };

  it('groups by the entry’s own scope labels, whatever the bank calls them', async () => {
    // The labels are the bank's vocabulary, not Artemis's: a brand-first bank
    // groups by brand and system, and this pane has no business translating
    // that into org and project.
    status = { ...NO_BANKS, masterEnabled: true, banks: [bank()] };
    bankMemories = [
      memory({ name: 'one', file: 'a/one.md', scope: { brand: 'cool-jams', system: 'ops' } }),
      memory({ name: 'two', file: 'b/two.md', scope: {} }),
    ];
    await renderPane();
    await open();

    expect(screen.getByText(/cool-jams \/ ops/)).toBeTruthy();
    // No labels at all is a real answer, and it is not "unknown" — it is
    // unfiled.
    expect(screen.getByText(/unfiled/)).toBeTruthy();
  });

  it('shows why an entry did not reach the agents', async () => {
    status = { ...NO_BANKS, masterEnabled: true, banks: [bank()] };
    bankMemories = [
      memory({ name: 'broken', problems: ['metadata.type must be one of decision, feedback, reference, workflow'] }),
    ];
    await renderPane();
    await open();

    // Listed rather than hidden: the person who can fix it has to be able to
    // find it, and the reason is the only useful part.
    expect(screen.getByText('not installed')).toBeTruthy();
    expect(screen.getByText(/metadata.type must be one of/)).toBeTruthy();
  });
});

describe('a preflight that could not be read', () => {
  it('says what went wrong instead of claiming it is still checking', async () => {
    // The Windows case. `Checking what this machine needs…` was the only thing
    // this pane ever said on a machine with no Python — a sentence that is
    // never true once the read has finished.
    preflight = {
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'Python 3 is required for the team memory bank CLI, and this machine has none.',
        retryable: false,
      },
    };
    await renderPane();

    expect(screen.queryByText(/Checking what this machine needs/)).toBeNull();
    expect(screen.getByText(/Python 3 is required/)).toBeTruthy();
  });

  it('does not block the join on a preflight it never got', async () => {
    // An unreadable preflight is not evidence of a broken machine, and the
    // add's own error is a better teacher than a disabled button.
    preflight = {
      ok: false,
      error: { code: 'internal', message: 'the CLI did not respond', retryable: true },
    };
    await renderPane();
    fillJoin();
    expect(joinButton().hasAttribute('disabled')).toBe(false);
  });
});

describe('slugFromRemote', () => {
  it('names the bank after the repository, lowercased', () => {
    // The reported case. `Cortex` is what the URL shows the user, and it is
    // exactly what the slug grammar refuses — so the suggestion has to do the
    // lowercasing rather than leave them guessing at a dead button.
    expect(slugFromRemote('http://system-dokploy:8300/david/Cortex.git')).toBe('cortex');
  });

  it('handles the shapes a remote actually arrives in', () => {
    expect(slugFromRemote('https://forgejo.example.com/team/Team_Docs.git')).toBe('team-docs');
    expect(slugFromRemote('git@github.com:org/my-bank.git')).toBe('my-bank');
    expect(slugFromRemote('https://host/x/Cortex')).toBe('cortex');
    expect(slugFromRemote('http://host:8300/david/bank/')).toBe('bank');
  });

  it('suggests nothing rather than something wrong', () => {
    // It runs on every keystroke of a half-typed URL, so silence is the only
    // safe answer for input that does not reduce to a legal slug.
    expect(slugFromRemote('')).toBe('');
    expect(slugFromRemote('   ')).toBe('');
    expect(slugFromRemote('https://host/x/___')).toBe('');
  });
});

/**
 * The alternative this phase added: point the bank at a secret's *address*
 * instead of pasting the secret.
 *
 * What is pinned here is the shape of the offer rather than its styling.
 * Pasting a token stays exactly as it was — a machine with no key manager
 * meets the form it always met — and the second source, when chosen, produces
 * a request carrying a `ref` and no `token`, which is the whole difference
 * between a bank that holds a credential and one that does not.
 *
 * The Test button gets its own tests because it is the difference between
 * finding a mistyped key here and finding it days later in a background sync
 * that quietly stopped.
 */
describe('joining a bank with a key-manager reference', () => {
  const chooseKeyManager = async (): Promise<void> => {
    await act(async () => {
      screen.getByRole('button', { name: 'From a key manager' }).click();
    });
  };

  it('leaves "paste a token" as the default, so nothing changes for a machine without one', async () => {
    await renderPane();
    expect(screen.getByLabelText(/Access token/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'From a key manager' })).toBeTruthy();
  });

  it('points at the Key managers pane when there is no manager to choose', async () => {
    connections = [];
    await renderPane();
    await chooseKeyManager();
    // A dead end with no instruction is how a user concludes the feature is
    // broken rather than unconfigured.
    expect(screen.getByText(/No key manager is connected/)).toBeTruthy();
  });

  it('replaces the token field with the provider’s own reference fields', async () => {
    await renderPane();
    await chooseKeyManager();
    // The token field is gone — the point of choosing this source is that
    // there is no token to type.
    expect(screen.queryByLabelText(/Access token/)).toBeNull();

    await act(async () => {
      screen.getByRole('button', { name: 'Work vault' }).click();
    });
    expect(screen.getByLabelText('Mount')).toBeTruthy();
    expect(screen.getByLabelText('Path')).toBeTruthy();
    expect(screen.getByLabelText('Key')).toBeTruthy();
    // Doppler's fields, not OpenBao's, when a Doppler connection is chosen.
    await act(async () => {
      screen.getByRole('button', { name: 'Team Doppler' }).click();
    });
    expect(screen.getByLabelText('Secret')).toBeTruthy();
    expect(screen.queryByLabelText('Mount')).toBeNull();
  });

  const fillOpenBaoRef = (over: { key?: string } = {}): void => {
    fireEvent.change(screen.getByLabelText('Mount'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByLabelText('Path'), { target: { value: 'claude/artemis' } });
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: over.key ?? 'git_token' } });
  };

  it('will not test an incomplete reference', async () => {
    await renderPane();
    await chooseKeyManager();
    await act(async () => {
      screen.getByRole('button', { name: 'Work vault' }).click();
    });

    expect(screen.getByRole('button', { name: 'Test' }).hasAttribute('disabled')).toBe(true);
    await act(async () => {
      fillOpenBaoRef();
    });
    expect(screen.getByRole('button', { name: 'Test' }).hasAttribute('disabled')).toBe(false);
  });

  it('will not test a reference the shared grammar refuses', async () => {
    // The same function main validates with. A pane that let a `..` through
    // and waited for the rejection would be teaching the rule twice.
    await renderPane();
    await chooseKeyManager();
    await act(async () => {
      screen.getByRole('button', { name: 'Work vault' }).click();
    });
    await act(async () => {
      fillOpenBaoRef();
      fireEvent.change(screen.getByLabelText('Path'), { target: { value: '../sys/seal' } });
    });
    expect(screen.getByRole('button', { name: 'Test' }).hasAttribute('disabled')).toBe(true);
    expect(testRefCalls).toEqual([]);
  });

  it('resolves the reference for real and says so without showing a value', async () => {
    await renderPane();
    await chooseKeyManager();
    await act(async () => {
      screen.getByRole('button', { name: 'Work vault' }).click();
    });
    await act(async () => {
      fillOpenBaoRef();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Test' }).click();
    });

    expect(testRefCalls).toEqual([
      {
        ref: {
          provider: 'openbao',
          connectionId: 'sec-1',
          mount: 'secret',
          path: 'claude/artemis',
          key: 'git_token',
        },
      },
    ]);
    expect(screen.getByText(/Resolved\./)).toBeTruthy();
    expect(screen.getByText(/discarded/)).toBeTruthy();
  });

  it('renders the key names on a miss, because that is the sentence that fixes it', async () => {
    refTestAnswer = {
      found: false,
      problem: 'secret/claude/artemis has no key named “git-token”.',
      keysAtPath: ['git_token', 'username'],
    };
    await renderPane();
    await chooseKeyManager();
    await act(async () => {
      screen.getByRole('button', { name: 'Work vault' }).click();
    });
    await act(async () => {
      fillOpenBaoRef({ key: 'git-token' });
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Test' }).click();
    });

    expect(screen.getByText(/no key named/)).toBeTruthy();
    expect(screen.getByText(/git_token, username/)).toBeTruthy();
  });

  it('renders a denial as a denial, never as "not found"', async () => {
    refTestAnswer = {
      found: false,
      problem:
        'OpenBao refused kv/team (403). It answers identically for a path this token’s policy does not allow, for a path that does not exist, and for a mount that does not exist, so this is “denied, or absent” and it will not say which.',
    };
    await renderPane();
    await chooseKeyManager();
    await act(async () => {
      screen.getByRole('button', { name: 'Work vault' }).click();
    });
    await act(async () => {
      fillOpenBaoRef();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Test' }).click();
    });

    expect(screen.getByText(/denied, or absent/)).toBeTruthy();
  });

  it('sends a ref and no token with the join', async () => {
    await renderPane();
    fillJoin();
    await chooseKeyManager();
    await act(async () => {
      screen.getByRole('button', { name: 'Work vault' }).click();
    });
    await act(async () => {
      fillOpenBaoRef();
    });
    await act(async () => {
      joinButton().click();
    });

    expect(addCalls).toHaveLength(1);
    const request = addCalls[0] as { auth?: Record<string, unknown> };
    expect(request.auth).toEqual({
      ref: {
        provider: 'openbao',
        connectionId: 'sec-1',
        mount: 'secret',
        path: 'claude/artemis',
        key: 'git_token',
      },
    });
    // Exactly one of the two: a request carrying both would be two answers to
    // one question, and main refuses it.
    expect(request.auth).not.toHaveProperty('token');
  });

  it('builds a Doppler reference against the Doppler connection, not the first one', async () => {
    // The other provider, end to end through the same form: a different
    // connection id, a different field set, and a differently shaped ref. With
    // one connection and one provider in the fixture none of that is proven —
    // and "both providers are first class" is exactly the claim being made.
    await renderPane();
    fillJoin();
    await chooseKeyManager();
    await act(async () => {
      screen.getByRole('button', { name: 'Team Doppler' }).click();
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Secret'), { target: { value: 'GIT_TOKEN' } });
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Test' }).click();
    });

    expect(testRefCalls).toEqual([
      { ref: { provider: 'doppler', connectionId: 'sec-2', name: 'GIT_TOKEN' } },
    ]);

    await act(async () => {
      joinButton().click();
    });
    const request = addCalls[0] as { auth?: Record<string, unknown> };
    expect(request.auth).toEqual({
      ref: { provider: 'doppler', connectionId: 'sec-2', name: 'GIT_TOKEN' },
    });
    // No mount and no path: Doppler has neither, and a ref carrying OpenBao's
    // shape would be the form remembering the provider it was last on.
    expect(request.auth?.['ref']).not.toHaveProperty('mount');
    expect(request.auth?.['ref']).not.toHaveProperty('path');
  });

  it('still offers the username, because git echoes it either way', async () => {
    await renderPane();
    await chooseKeyManager();
    expect(screen.queryByLabelText('Username')).toBeNull();
    await act(async () => {
      screen.getByRole('button', { name: /Username/ }).click();
    });
    expect(screen.getByLabelText('Username')).toBeTruthy();
  });
});

describe('a bank whose credential lives in a key manager', () => {
  it('says so on the row, and says when it has stopped resolving', async () => {
    status = {
      ...NO_BANKS,
      masterEnabled: true,
      banks: [bank({ credential: { kind: 'ref' } })],
    };
    await renderPane();
    expect(screen.getByText('key manager')).toBeTruthy();

    cleanup();
    // The degraded case: the sync did not happen, nothing blocked, and the
    // pane is where a person finds out why.
    status = {
      ...status,
      banks: [
        {
          ...status.banks[0]!,
          credential: { kind: 'ref', problem: 'OpenBao is sealed, so it cannot be read.' },
        },
      ],
    };
    await renderPane();
    expect(screen.getByText('key manager unreachable')).toBeTruthy();
    expect(screen.getByText(/OpenBao is sealed/)).toBeTruthy();
  });
});
