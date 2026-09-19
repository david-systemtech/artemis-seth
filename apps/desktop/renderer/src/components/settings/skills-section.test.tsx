/**
 * @vitest-environment jsdom
 *
 * The Skills pane.
 *
 * What is worth asserting is where it can mislead someone about their next
 * conversation: a switch that reads "on" for a skill no run will be given, a
 * choice that vanishes from view because its folder is away, a skill nobody
 * described drawn as though the model could find it, and the price of always-on
 * left unsaid until after it is paid.
 *
 * Same caveat as the other component tests: `renderer/tsconfig.json` excludes
 * them, so `pnpm typecheck` never sees this file and the assertions are
 * behavioural.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type {
  SkillInfo,
  SkillLibraryDocument,
  SkillSourceStatus,
  SkillsSaveRequest,
  SkillsSourceAddRequest,
} from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import { SkillsSection } from '@/components/settings/SkillsSection';
import { TooltipProvider } from '@/components/ui/tooltip';
import { seedApp } from '@/state/testkit';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});

const ok = <T,>(value: T) => ({ ok: true as const, value });
const failed = (message: string) => ({ ok: false as const, error: { code: 'unknown', message } });

const skill = (over: Partial<SkillInfo> & Pick<SkillInfo, 'name'>): SkillInfo => ({
  description: `What ${over.name} is for.`,
  origin: { kind: 'machine' },
  dir: `/home/u/.agents/skills/${over.name}`,
  modelInvocable: true,
  userInvocable: true,
  bodyChars: 4_000,
  ...over,
});

let skills: readonly SkillInfo[] = [];
let stored: SkillLibraryDocument = { version: 1, alwaysOn: [] };
let listFails: string | null = null;
let saveFails: string | null = null;
/**
 * Per-save outcomes, taken in order: a message fails that save, `null` lets it
 * land. Once it runs out, `saveFails` decides. For the interleavings a single
 * outcome cannot script.
 */
let saveScript: (string | null)[] = [];
const saves: SkillsSaveRequest[] = [];
let sources: readonly SkillSourceStatus[] = [];
/** Why the next source action fails, or `null` for it to succeed. */
let sourceFails: string | null = null;
const added: SkillsSourceAddRequest[] = [];
const removed: string[] = [];
const pulled: (string | undefined)[] = [];

/** What the server answers, or why it cannot be asked. `null` state means "too old to list". */
let server: {
  skills: readonly SkillInfo[];
  sources: readonly SkillSourceStatus[];
  manage: boolean;
  available: boolean;
} = { skills: [], sources: [], manage: true, available: true };
let serverFails: string | null = null;
const serverCalls: { what: string; request: unknown }[] = [];
const serverState = () => ({
  available: server.available,
  manage: server.manage,
  skills: server.skills,
  sources: server.sources,
  accounts: [{ id: 'srv-work', slug: 'work-max', label: 'Work Max' }],
});

/** Installed before the first render: `resolveBridge` memoises on first use. */
(globalThis.window as unknown as { artemis: unknown }).artemis = {
  serverSkills: {
    list: async (request: unknown) => {
      serverCalls.push({ what: 'list', request });
      return serverFails === null ? ok(serverState()) : failed(serverFails);
    },
    addSource: async (request: { url: string }) => {
      serverCalls.push({ what: 'add', request });
      if (serverFails !== null) return failed(serverFails);
      server = { ...server, sources: [...server.sources, sourceStatus(request.url, { skillCount: 3 })] };
      return ok(serverState());
    },
    removeSource: async (request: { id: string }) => {
      serverCalls.push({ what: 'remove', request });
      server = { ...server, sources: server.sources.filter((status) => status.source.id !== request.id) };
      return ok(serverState());
    },
    syncSources: async (request: unknown) => {
      serverCalls.push({ what: 'sync', request });
      return ok(serverState());
    },
  },
  skills: {
    list: async () => (listFails === null ? ok({ skills, document: stored, sources }) : failed(listFails)),
    save: async (request: SkillsSaveRequest) => {
      saves.push(request);
      const outcome = saveScript.length > 0 ? saveScript.shift() : saveFails;
      if (outcome !== null && outcome !== undefined) return failed(outcome);
      stored = request.document;
      return ok({ document: stored });
    },
    addSource: async (request: SkillsSourceAddRequest) => {
      added.push(request);
      if (sourceFails !== null) return failed(sourceFails);
      // What main does: clone it, then answer with everything that changed.
      sources = [...sources, sourceStatus(request.url, { skillCount: 1 })];
      skills = [...skills, skill({ name: 'from-the-repo', origin: { kind: 'source', sourceId: sources.at(-1)!.source.id } })];
      return ok({ skills, document: stored, sources });
    },
    removeSource: async (request: { id: string }) => {
      removed.push(request.id);
      if (sourceFails !== null) return failed(sourceFails);
      sources = sources.filter((status) => status.source.id !== request.id);
      return ok({ skills, document: stored, sources });
    },
    syncSources: async (request: { id?: string }) => {
      pulled.push(request.id);
      if (sourceFails !== null) return failed(sourceFails);
      return ok({ skills, document: stored, sources });
    },
  },
};

/** One subscribed repository, cloned and current unless told otherwise. */
function sourceStatus(url: string, over: Partial<SkillSourceStatus> = {}): SkillSourceStatus {
  return {
    source: { id: `id-${url.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, url, subdir: 'skills' },
    cloned: true,
    head: 'a1b2c3d',
    syncedAt: Date.now() - 5 * 60_000,
    skillCount: 12,
    ...over,
  };
}

async function renderPane(): Promise<void> {
  render(
    <TooltipProvider>
      <SkillsSection />
    </TooltipProvider>,
  );
  await act(async () => {});
}

const toggle = (name: string): HTMLElement => screen.getByRole('switch', { name: `Load into every prompt: ${name}` });
const isOn = (name: string): boolean => toggle(name).getAttribute('aria-checked') === 'true';

beforeEach(() => {
  server = { skills: [], sources: [], manage: true, available: true };
  serverFails = null;
  serverCalls.length = 0;
  sources = [];
  sourceFails = null;
  added.length = 0;
  removed.length = 0;
  pulled.length = 0;
  skills = [skill({ name: 'tdd' }), skill({ name: 'unslop' })];
  stored = { version: 1, alwaysOn: [] };
  listFails = null;
  saveFails = null;
  saveScript = [];
  seedApp({
    profiles: [{ id: 'p-work', label: 'Work', providerId: 'claude', configDir: '/home/u/.claude-work' }],
    providers: [],
  });
});

afterEach(() => {
  cleanup();
  saves.length = 0;
});

describe('the list', () => {
  it('draws each skill as the command to type, with what it says it is for', async () => {
    await renderPane();

    expect(screen.getByText('/artemis-skills:unslop')).toBeTruthy();
    expect(screen.getByText('What unslop is for.')).toBeTruthy();
    expect(screen.getByText('/artemis-skills:tdd')).toBeTruthy();
  });

  it('says what always-on costs before the switch is thrown', async () => {
    skills = [skill({ name: 'unslop', bodyChars: 4_000 }), skill({ name: 'big', bodyChars: 22_000 })];
    await renderPane();

    // Order of magnitude, which is all anyone needs: a thousand or five.
    expect(screen.getByText(/loaded into every prompt, not only when it applies: about 1\.0k tokens each time/)).toBeTruthy();
    expect(screen.getByText(/about 5\.5k tokens each time/)).toBeTruthy();
  });

  it('says beside every switch that it loads the skill into every prompt', async () => {
    skills = [skill({ name: 'tdd' }), skill({ name: 'unslop' })];
    await renderPane();

    // Visible, not only to a screen reader: a bare switch reads as "enable
    // this skill", and every skill is already available on request.
    const labels = screen.getAllByText('Every prompt', { selector: 'label' });
    expect(labels).toHaveLength(2);
    // And it is the switch's own label, so clicking the words throws it.
    fireEvent.click(labels[1]!);
    await act(async () => {});
    expect(isOn('unslop')).toBe(true);
    expect(isOn('tdd')).toBe(false);
  });

  it('names the repository a copied skill was written in, linked at the commit it was copied at', async () => {
    skills = [
      skill({
        name: 'tdd',
        upstream: {
          repo: 'mattpocock/skills',
          path: 'skills/engineering/tdd',
          commit: '74ca5fe077456a0b3b2f5310cf9430999fd0b5fd',
          license: 'MIT',
        },
      }),
      skill({ name: 'house-rules' }),
    ];
    await renderPane();

    const link = screen.getByRole('link', { name: 'mattpocock/skills' });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/mattpocock/skills/tree/74ca5fe077456a0b3b2f5310cf9430999fd0b5fd/skills/engineering/tdd',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.getByText(/· MIT · copied at 74ca5fe/)).toBeTruthy();
    // A skill nobody recorded says nothing about where it came from.
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('calls out a skill nobody described, because the model will never find it', async () => {
    skills = [skill({ name: 'scratch', description: '' })];
    await renderPane();

    expect(screen.getByText(/No description\. The model chooses a skill by this line/)).toBeTruthy();
  });

  it('says how each skill can be reached, since the frontmatter decides that', async () => {
    skills = [
      skill({ name: 'both' }),
      skill({ name: 'typed', modelInvocable: false }),
      skill({ name: 'background', userInvocable: false }),
    ];
    await renderPane();

    expect(screen.getByText(/The model picks it up when it applies, or type the command\./)).toBeTruthy();
    expect(screen.getByText(/Runs only when you type the command\./)).toBeTruthy();
    expect(screen.getByText(/Background knowledge: the model uses it when it applies/)).toBeTruthy();
  });

  it('names the accounts an account-only skill reaches, by the label a person knows', async () => {
    skills = [skill({ name: 'work-rules', origin: { kind: 'profile', profileIds: ['p-work' as never] } })];
    await renderPane();

    expect(screen.getByText(/Only on Work\./)).toBeTruthy();
  });

  it('draws the command a session offers, which is the file’s name for the skill and not always the folder’s', async () => {
    skills = [skill({ name: 'my-tdd', offeredAs: 'tdd' }), skill({ name: 'unslop' })];
    await renderPane();

    expect(screen.getByText('/artemis-skills:tdd')).toBeTruthy();
    expect(screen.queryByText('/artemis-skills:my-tdd')).toBeNull();
    // The switch is still the folder's: that is what an always-on choice refers to.
    expect(toggle('my-tdd')).toBeTruthy();
  });

  it('says so when a plugin offers the name on some accounts, and what to type there', async () => {
    skills = [
      skill({
        name: 'tdd',
        pluginOffers: [
          { plugin: 'mattpocock-skills', command: '/mattpocock-skills:tdd', profileIds: ['p-work' as never] },
        ],
      }),
      skill({ name: 'unslop' }),
    ];
    await renderPane();

    expect(screen.getByText(/On Work the mattpocock-skills plugin offers a skill of this name/)).toBeTruthy();
    expect(screen.getByText('/mattpocock-skills:tdd')).toBeTruthy();
    // Its own command is still drawn: every other account types that one.
    expect(screen.getByText('/artemis-skills:tdd')).toBeTruthy();
    // And a row no plugin touches says nothing of the kind.
    expect(screen.getAllByText(/plugin offers a skill of this name/)).toHaveLength(1);
  });

  it('says where to put a skill when there are none, rather than drawing an empty card', async () => {
    skills = [];
    await renderPane();

    expect(screen.getByText('No skills on this machine')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('always on', () => {
  it('shows what is stored, and saves the whole document when a switch is thrown', async () => {
    stored = { version: 1, alwaysOn: [{ name: 'tdd', scope: { kind: 'all' } }] };
    await renderPane();
    expect(isOn('tdd')).toBe(true);
    expect(isOn('unslop')).toBe(false);

    fireEvent.click(toggle('unslop'));
    await act(async () => {});

    expect(isOn('unslop')).toBe(true);
    expect(saves).toEqual([
      {
        document: {
          version: 1,
          alwaysOn: [
            { name: 'tdd', scope: { kind: 'all' } },
            { name: 'unslop', scope: { kind: 'all' } },
          ],
        },
      },
    ]);
  });

  it('switches off, and does not lose a switch thrown just before it', async () => {
    stored = { version: 1, alwaysOn: [{ name: 'tdd', scope: { kind: 'all' } }] };
    await renderPane();

    // Two gestures inside one tick: the second must build on the first, not on
    // the document the pane opened with.
    fireEvent.click(toggle('unslop'));
    fireEvent.click(toggle('tdd'));
    await act(async () => {});

    expect(saves.at(-1)?.document.alwaysOn).toEqual([{ name: 'unslop', scope: { kind: 'all' } }]);
    expect(isOn('tdd')).toBe(false);
    expect(isOn('unslop')).toBe(true);
  });

  it('puts the switch back and says why when the save fails', async () => {
    saveFails = 'The disk is full.';
    await renderPane();

    fireEvent.click(toggle('unslop'));
    await act(async () => {});

    // "On" for a skill no run will be given would be a lie about the next
    // conversation.
    expect(isOn('unslop')).toBe(false);
    expect(screen.getByRole('alert').textContent).toContain('The disk is full.');
  });

  it('ends on what was stored when a failed switch is followed by one that lands', async () => {
    await renderPane();
    saveScript = ['The disk is full.', null];

    // Two switches in one tick, so the second save carries the first switch
    // as well. The first save fails; the second stores both.
    fireEvent.click(toggle('tdd'));
    fireEvent.click(toggle('unslop'));
    await act(async () => {});

    // Every run is now given tdd. A pane showing it off would be the same lie
    // the failed-save rule exists to prevent, turned around, and the next
    // switch thrown would save that lie over the real choice.
    expect(stored.alwaysOn.map((entry) => entry.name)).toEqual(['tdd', 'unslop']);
    expect(isOn('tdd')).toBe(true);
    expect(isOn('unslop')).toBe(true);
  });

  it('puts a failed switch-off back exactly as it was stored, narrowed scope and all', async () => {
    const narrowed = { kind: 'profiles', profileIds: ['p-work'] } as const;
    stored = { version: 1, alwaysOn: [{ name: 'tdd', scope: narrowed }] };
    await renderPane();
    saveScript = ['The disk is full.'];

    fireEvent.click(toggle('tdd'));
    await act(async () => {});
    expect(isOn('tdd')).toBe(true);

    // The next switch saves the whole document, so what the failed one put
    // back is what gets written: the entry as it was, not one widened to
    // every account.
    fireEvent.click(toggle('unslop'));
    await act(async () => {});
    expect(saves.at(-1)?.document.alwaysOn).toEqual([
      { name: 'tdd', scope: narrowed },
      { name: 'unslop', scope: { kind: 'all' } },
    ]);
  });

  it('keeps a choice in view when its skill is not on this machine, so it can be switched off', async () => {
    stored = { version: 1, alwaysOn: [{ name: 'only-on-the-server', scope: { kind: 'all' } }] };
    await renderPane();

    expect(screen.getByText('On for every prompt, but not on this machine')).toBeTruthy();
    expect(isOn('only-on-the-server')).toBe(true);

    fireEvent.click(toggle('only-on-the-server'));
    await act(async () => {});

    expect(saves.at(-1)?.document.alwaysOn).toEqual([]);
    expect(screen.queryByText('On for every prompt, but not on this machine')).toBeNull();
  });

  it('draws no switches over a read that failed', async () => {
    listFails = 'Could not read the skills folder.';
    await renderPane();

    // A switch drawn here would, on its first click, replace the real choices
    // with whatever this pane guessed they were.
    expect(screen.getByRole('alert').textContent).toContain('Could not read the skills folder.');
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('prices nothing for a skill that only accounts never told can reach', async () => {
    const codex = (append: boolean) =>
      ({
        id: 'codex',
        label: 'Codex',
        capabilities: { ...NO_CAPABILITIES, systemPromptAppend: append },
        models: [],
        effortLevels: [],
        available: true,
      }) as never;
    seedApp({
      profiles: [{ id: 'p-codex', label: 'Codex account', providerId: 'codex', configDir: '/home/u/.codex' }],
      providers: [codex(false)],
    });
    skills = [skill({ name: 'tdd', origin: { kind: 'profile', profileIds: ['p-codex'] } })];
    await renderPane();

    // The switch reaches no run, so no run pays for it - and the row says so
    // rather than quoting a price nobody is charged.
    expect(screen.queryByText(/loaded into every prompt/)).toBeNull();
    expect(screen.getByText(/None of the accounts it reaches is told/)).toBeTruthy();
  });

  it('says plainly which conversations the switch does not reach', async () => {
    await renderPane();

    expect(screen.getByText(/A Codex or OpenCode account cannot take an appended prompt/)).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Repositories                                                               */
/* -------------------------------------------------------------------------- */

describe('skill repositories', () => {
  const URL = 'https://github.com/david-systemtech/agent-skills.git';
  const field = (): HTMLInputElement => screen.getByLabelText('Repository URL') as HTMLInputElement;
  const add = (): HTMLButtonElement => screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;

  it('says what a person needs to trust a copy: how many skills, how fresh, which commit', async () => {
    sources = [sourceStatus(URL)];
    await renderPane();

    expect(screen.getByText('david-systemtech/agent-skills')).toBeTruthy();
    expect(screen.getByText(/12 skills · synced 5m ago · a1b2c3d/)).toBeTruthy();
  });

  it('says a failed sync did not cost the skills it already had', async () => {
    // The first thing anyone wants to know about a failed sync.
    sources = [sourceStatus(URL, { error: 'Could not resolve host: github.com' })];
    await renderPane();

    const alert = screen.getByText(/Could not sync: Could not resolve host: github\.com/);
    expect(alert.textContent).toContain('Still using the copy it has');
    expect(alert.textContent).toContain('12 skills');
  });

  it('says so when a source has never been cloned, rather than implying skills that are not there', async () => {
    sources = [sourceStatus(URL, { cloned: false, skillCount: 0, error: 'Authentication failed', head: undefined, syncedAt: undefined })];
    await renderPane();

    expect(screen.getByText(/Nothing has been cloned yet, so it offers no skills/)).toBeTruthy();
  });

  it('names the repository on the row of a skill that came from one', async () => {
    sources = [sourceStatus(URL)];
    skills = [skill({ name: 'unslop', origin: { kind: 'source', sourceId: sources[0]!.source.id } })];
    await renderPane();

    expect(screen.getByText(/Every account on this machine, synced from david-systemtech\/agent-skills\./)).toBeTruthy();
  });

  it('adds a repository, shows what the clone brought, and clears the field', async () => {
    await renderPane();
    expect(add().disabled).toBe(true);

    fireEvent.change(field(), { target: { value: `  ${URL} ` } });
    expect(add().disabled).toBe(false);
    fireEvent.click(add());
    await act(async () => {});

    expect(added).toEqual([{ url: URL, subdir: 'skills' }]);
    // Main's whole answer is adopted: the source, and the skills it cloned.
    expect(screen.getByText('david-systemtech/agent-skills')).toBeTruthy();
    expect(screen.getByText('/artemis-skills:from-the-repo')).toBeTruthy();
    expect(field().value).toBe('');
  });

  it('refuses a URL main would refuse, in the same words, before anything is sent', async () => {
    await renderPane();

    fireEvent.change(field(), { target: { value: 'https://me:my-token-value@github.com/a/b.git' } });

    // A token in a URL is a secret in a settings file. Refused as it is typed.
    expect(screen.getByRole('alert').textContent).toContain('git credentials');
    expect(add().disabled).toBe(true);
    fireEvent.submit(field().closest('form')!);
    await act(async () => {});
    expect(added).toEqual([]);
  });

  it('keeps the URL in the field when adding fails, and says why', async () => {
    sourceFails = 'Repository not found.';
    await renderPane();

    fireEvent.change(field(), { target: { value: URL } });
    fireEvent.click(add());
    await act(async () => {});

    // A URL that failed is one the person is about to correct, not retype.
    expect(field().value).toBe(URL);
    expect(screen.getByRole('alert').textContent).toContain('Repository not found.');
  });

  it('pulls one repository now, and removes one', async () => {
    sources = [sourceStatus(URL)];
    await renderPane();

    fireEvent.click(screen.getByRole('button', { name: 'Pull now: david-systemtech/agent-skills' }));
    await act(async () => {});
    expect(pulled).toEqual([sources[0]!.source.id]);

    const id = sources[0]!.source.id;
    fireEvent.click(screen.getByRole('button', { name: 'Remove: david-systemtech/agent-skills' }));
    await act(async () => {});
    expect(removed).toEqual([id]);
    expect(screen.queryByText('david-systemtech/agent-skills')).toBeNull();
  });

  it('leaves the always-on switches alone when a repository changes', async () => {
    stored = { version: 1, alwaysOn: [{ name: 'tdd', scope: { kind: 'all' } }] };
    await renderPane();

    fireEvent.change(field(), { target: { value: URL } });
    fireEvent.click(add());
    await act(async () => {});

    expect(isOn('tdd')).toBe(true);
    expect(saves).toEqual([]);
  });
});

/**
 * A conversation on an Artemis server runs there, with the server's skills.
 * The pane has to show what those are, because the switch travels by name and
 * a name the server does not carry adds nothing to a run over there.
 */
describe('an Artemis server', () => {
  const withServer = (): void => {
    seedApp({
      profiles: [
        { id: 'p-work', label: 'Work', providerId: 'claude', configDir: '/home/u/.claude-work' },
        { id: 'p-server', label: 'Home Server', providerId: 'artemis', configDir: '/home/u/.artemis/server' },
      ],
      providers: [],
    });
  };

  it('draws no server group on a machine with no server profile, and asks no server anything', async () => {
    await renderPane();
    // "On this machine" is the only place there is.
    expect(screen.queryByText(/^On (?!this machine)/)).toBeNull();
    expect(serverCalls).toEqual([]);
  });

  it('lists what the server carries, under its own name, with its own switch', async () => {
    withServer();
    skills = [skill({ name: 'unslop' })];
    server = { ...server, skills: [skill({ name: 'unslop' }), skill({ name: 'deploy-checklist' })] };
    await renderPane();

    expect(screen.getByText('On Home Server')).toBeTruthy();
    expect(serverCalls[0]).toEqual({ what: 'list', request: { profileId: 'p-server' } });
    // The same skill on both machines is two rows and one choice.
    fireEvent.click(screen.getByRole('switch', { name: 'Load into every prompt: unslop, on Home Server' }));
    await act(async () => {});
    expect(isOn('unslop')).toBe(true);
    expect(screen.getByRole('switch', { name: 'Load into every prompt: unslop, on Home Server' }).getAttribute('aria-checked')).toBe('true');
    // Both of the server's rows say where they are, and neither says "this machine".
    expect(screen.getAllByText(/Every account on Home Server\./)).toHaveLength(2);
  });

  it('does not call a choice missing when only the server has the skill', async () => {
    withServer();
    skills = [];
    stored = { version: 1, alwaysOn: [{ name: 'deploy-checklist', scope: { kind: 'all' } }] };
    server = { ...server, skills: [skill({ name: 'deploy-checklist' })] };
    await renderPane();

    expect(screen.queryByText(/not installed anywhere/)).toBeNull();
    expect(screen.getByRole('switch', { name: 'Load into every prompt: deploy-checklist, on Home Server' }).getAttribute('aria-checked')).toBe('true');
  });

  it('adds, pulls and removes the server’s repositories through the server', async () => {
    withServer();
    server = { ...server, sources: [sourceStatus('https://github.com/demo/ops-skills')] };
    await renderPane();

    fireEvent.change(screen.getByLabelText('Repository URL, for Home Server'), {
      target: { value: 'https://github.com/demo/agent-skills' },
    });
    // The local form has an Add of its own; the server's is the last on the page.
    fireEvent.click(screen.getAllByRole('button', { name: 'Add' }).at(-1)!);
    await act(async () => {});
    expect(serverCalls.at(-1)).toEqual({
      what: 'add',
      request: { profileId: 'p-server', url: 'https://github.com/demo/agent-skills', subdir: 'skills' },
    });
    expect(screen.getByText('demo/agent-skills')).toBeTruthy();
    // Nothing was cloned on this machine.
    expect(added).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Pull now: demo/ops-skills' }));
    await act(async () => {});
    expect(serverCalls.at(-1)?.what).toBe('sync');
    fireEvent.click(screen.getByRole('button', { name: 'Remove: demo/ops-skills' }));
    await act(async () => {});
    expect(screen.queryByText('demo/ops-skills')).toBeNull();
  });

  it('shows a token without the grant the repositories, and says why it cannot change them', async () => {
    withServer();
    server = { ...server, manage: false, sources: [sourceStatus('https://github.com/demo/ops-skills')] };
    await renderPane();

    expect(screen.getByText('demo/ops-skills')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pull now: demo/ops-skills' })).toBeNull();
    expect(screen.queryByLabelText('Repository URL, for Home Server')).toBeNull();
    expect(screen.getByText(/can see the server’s repositories but not change them/)).toBeTruthy();
  });

  it('says so when the server is too old to read always-on skills, or cannot be reached', async () => {
    withServer();
    server = { ...server, available: false };
    await renderPane();
    expect(screen.getByText(/too old to read always-on skills/)).toBeTruthy();

    cleanup();
    serverFails = 'Could not reach the Artemis server at https://home.example.';
    await renderPane();
    expect(screen.getByText(/Could not ask Home Server for its skills: Could not reach/)).toBeTruthy();
  });

  it('tells a person that the switch travels by name and the server adds its own copy', async () => {
    await renderPane();
    expect(screen.getByText(/the switch travels with it by name/)).toBeTruthy();
  });
});
