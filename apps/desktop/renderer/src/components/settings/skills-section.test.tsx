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
import type { SkillInfo, SkillLibraryDocument, SkillsSaveRequest } from '@rx-artemis/protocol';
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

/** Installed before the first render: `resolveBridge` memoises on first use. */
(globalThis.window as unknown as { artemis: unknown }).artemis = {
  skills: {
    list: async () => (listFails === null ? ok({ skills, document: stored }) : failed(listFails)),
    save: async (request: SkillsSaveRequest) => {
      saves.push(request);
      const outcome = saveScript.length > 0 ? saveScript.shift() : saveFails;
      if (outcome !== null && outcome !== undefined) return failed(outcome);
      stored = request.document;
      return ok({ document: stored });
    },
  },
};

async function renderPane(): Promise<void> {
  render(
    <TooltipProvider>
      <SkillsSection />
    </TooltipProvider>,
  );
  await act(async () => {});
}

const toggle = (name: string): HTMLElement => screen.getByRole('switch', { name: `Always on: ${name}` });
const isOn = (name: string): boolean => toggle(name).getAttribute('aria-checked') === 'true';

beforeEach(() => {
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
    expect(screen.getByText(/adds about 1\.0k tokens to every run/)).toBeTruthy();
    expect(screen.getByText(/adds about 5\.5k tokens to every run/)).toBeTruthy();
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

    expect(screen.getByText('Always on, but not on this machine')).toBeTruthy();
    expect(isOn('only-on-the-server')).toBe(true);

    fireEvent.click(toggle('only-on-the-server'));
    await act(async () => {});

    expect(saves.at(-1)?.document.alwaysOn).toEqual([]);
    expect(screen.queryByText('Always on, but not on this machine')).toBeNull();
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
    expect(screen.queryByText(/Always on adds about/)).toBeNull();
    expect(screen.getByText(/None of the accounts it reaches is told/)).toBeTruthy();
  });

  it('says plainly which conversations the switch does not reach', async () => {
    await renderPane();

    expect(screen.getByText(/A Codex or OpenCode account cannot take an appended prompt/)).toBeTruthy();
  });
});
