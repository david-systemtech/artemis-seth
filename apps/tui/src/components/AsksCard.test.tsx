/**
 * The card answers several conversations at once, which is exactly why every
 * case here is about what it refuses to do.
 *
 * `y` and `n` are the whole reason the card exists, so they are checked for
 * the decision they send *and* for the row leaving afterwards — a row that
 * lingered could be answered twice. Everything else is a boundary: Enter goes
 * to the full card rather than allowing anything, a question has no yes to
 * give, the bulk keys wait for a confirmation, and Esc — which denies on
 * `PermissionCard` — decides nothing here, because one keystroke must not be
 * able to refuse four conversations.
 *
 * Keys are written as the bytes a terminal really sends.
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

import type { PermissionDecision, PermissionRequest } from '@rx-artemis/protocol';

import { AsksCard, askRows, type Ask } from './AsksCard.js';
import { DEFAULT_DENIAL } from './PermissionCard.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

const ENTER = '\r';
const ESC = '\u001B';
const DOWN = '\u001B[B';
const UP = '\u001B[A';

/** Keystrokes in order, a tick apart, as Ink delivers them. */
const press = async (stdin: { write: (data: string) => void }, ...keys: readonly string[]): Promise<void> => {
  for (const key of keys) {
    stdin.write(key);
    await tick();
  }
};

const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'req' as never,
  runId: 'run' as never,
  toolName: 'Bash',
  input: { command: 'rm -rf build' },
  requestedAt: 0,
  ...over,
});

const ask = (over: Partial<Ask> & { readonly key: string }): Ask => ({
  title: over.key,
  request: request(),
  decide: () => {},
  open: () => {},
  ...over,
});

const decision = (): ReturnType<typeof vi.fn<(d: PermissionDecision) => void>> =>
  vi.fn<(d: PermissionDecision) => void>();

const QUESTION: PermissionRequest = request({
  toolName: 'AskUserQuestion',
  input: {},
  title: 'Claude has a question',
  question: {
    questions: [
      {
        question: 'Which database?',
        header: 'Database',
        multiSelect: false,
        options: [
          { label: 'Postgres', description: 'relational' },
          { label: 'SQLite', description: 'embedded' },
        ],
      },
    ],
  },
});

const PLAN: PermissionRequest = request({
  toolName: 'ExitPlanMode',
  input: {},
  title: 'Claude is ready to code',
  plan: { plan: '# Steps\n\n- do the thing' },
});

describe('askRows', () => {
  it('names the conversation and says what it is being asked', () => {
    const rows = askRows(
      [
        ask({ key: 'a', title: 'fix the tests' }),
        ask({
          key: 'b',
          title: 'docs pass',
          request: request({ toolName: 'Write', input: { file_path: 'docs/adr/0002.md' } }),
        }),
      ],
      80,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.title).toBe('fix the tests');
    // No provider sentence, so the tool and the argument that tells you most.
    expect(rows[0]?.detail).toBe('Bash rm -rf build');
    expect(rows[1]?.detail).toBe('Write docs/adr/0002.md');
    expect(rows.every((row) => row.decidable)).toBe(true);
  });

  it('prefers the provider sentence, and a question prefers the question', () => {
    const rows = askRows(
      [
        ask({ key: 'a', title: 'one', request: request({ title: 'Claude wants to run rm -rf build' }) }),
        ask({ key: 'b', title: 'two', request: QUESTION }),
        ask({ key: 'c', title: 'three', request: PLAN }),
      ],
      80,
    );

    expect(rows[0]?.detail).toBe('Claude wants to run rm -rf build');
    expect(rows[1]?.detail).toBe('Which database?');
    expect(rows[2]?.detail).toBe('Claude is ready to code');
  });

  it('tags a question and a plan, and lets neither be decided from a row', () => {
    const rows = askRows([ask({ key: 'q', request: QUESTION }), ask({ key: 'p', request: PLAN })], 80);

    expect(rows[0]?.tag).toBe('question');
    expect(rows[0]?.decidable).toBe(false);
    expect(rows[1]?.tag).toBe('plan');
    expect(rows[1]?.decidable).toBe(false);
    // An approval carries no word: its row is the tool call and nothing else.
    expect(askRows([ask({ key: 'a' })], 80)[0]?.tag).toBe('');
  });

  it('cuts both halves of the row to the width it was given', () => {
    const long = 'a conversation with a truly unreasonable name that nobody would ever type';
    const rows = askRows([ask({ key: 'a', title: long, request: request({ title: 'x'.repeat(200) }) })], 48);
    const row = rows[0];

    expect(row?.title.length).toBeLessThanOrEqual(28);
    expect(row?.title.endsWith('…')).toBe(true);
    expect(row?.detail.endsWith('…')).toBe(true);
    expect((row?.title.length ?? 0) + (row?.detail.length ?? 0)).toBeLessThanOrEqual(48);
  });

  it('marks the conversation the card is sitting on top of', () => {
    const rows = askRows([ask({ key: 'a', current: true }), ask({ key: 'b' })], 80);
    expect(rows[0]?.current).toBe(true);
    expect(rows[1]?.current).toBe(false);
  });
});

describe('AsksCard', () => {
  it('draws a row per conversation, with its name and its tool call', async () => {
    const { lastFrame } = render(
      <AsksCard
        asks={[
          ask({ key: 'a', title: 'fix the tests', current: true }),
          ask({ key: 'b', title: 'api migration', request: QUESTION }),
          ask({
            key: 'c',
            title: 'docs pass',
            request: request({ toolName: 'Write', input: { file_path: 'docs/adr/0002.md' } }),
          }),
        ]}
        columns={80}
        onClose={() => {}}
      />,
    );
    await tick();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('3 conversations are waiting on you');
    expect(frame).toContain('fix the tests (here)');
    expect(frame).toContain('Bash rm -rf build');
    expect(frame).toContain('question Which database?');
    expect(frame).toContain('Write docs/adr/0002.md');
    // The cursor opens on the first row, and the first row is not an answer.
    expect(frame).toContain('❯ fix the tests');
    expect(frame).toContain('Enter open');
  });

  it('allows a row once with y and takes the row out of the list', async () => {
    const decide = decision();
    const { lastFrame, stdin } = render(
      <AsksCard
        asks={[ask({ key: 'a', title: 'fix the tests', decide }), ask({ key: 'b', title: 'api migration' })]}
        columns={80}
        onClose={() => {}}
      />,
    );
    await tick();
    await press(stdin, 'y');

    expect(decide).toHaveBeenCalledWith({ behavior: 'allow', scope: 'once' });
    expect(lastFrame()).not.toContain('fix the tests');
    expect(lastFrame()).toContain('api migration');
    expect(lastFrame()).toContain('1 conversation is waiting on you');
  });

  it('denies a row with n, with the sentence the other card sends', async () => {
    const first = decision();
    const second = decision();
    const { lastFrame, stdin } = render(
      <AsksCard
        asks={[
          ask({ key: 'a', title: 'fix the tests', decide: first }),
          ask({ key: 'b', title: 'api migration', decide: second }),
        ]}
        columns={80}
        onClose={() => {}}
      />,
    );
    await tick();
    // Down, then `n`: the second row is the one denied, not the one the
    // cursor started on.
    await press(stdin, DOWN, 'n');

    expect(second).toHaveBeenCalledWith({ behavior: 'deny', message: DEFAULT_DENIAL });
    expect(first).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('fix the tests');
    expect(lastFrame()).not.toContain('api migration');
  });

  it('opens the conversation on Enter and closes, deciding nothing', async () => {
    const open = vi.fn<() => void>();
    const decide = decision();
    const onClose = vi.fn<() => void>();
    const { stdin } = render(
      <AsksCard
        asks={[ask({ key: 'a', title: 'fix the tests', open, decide }), ask({ key: 'b', title: 'api migration' })]}
        columns={80}
        onClose={onClose}
      />,
    );
    await tick();
    await press(stdin, ENTER);

    expect(open).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(decide).not.toHaveBeenCalled();
  });

  it('will not answer a question row with y; it can only be opened', async () => {
    const decide = decision();
    const open = vi.fn<() => void>();
    const { lastFrame, stdin } = render(
      <AsksCard
        asks={[
          ask({ key: 'q', title: 'api migration', request: QUESTION, decide, open }),
          ask({ key: 'b', title: 'fix the tests' }),
        ]}
        columns={80}
        onClose={() => {}}
      />,
    );
    await tick();
    await press(stdin, 'y', 'n');

    expect(decide).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('api migration');
    expect(lastFrame()).toContain('answered on its own card');

    await press(stdin, ENTER);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('asks before a allows every approval row, and leaves the question alone', async () => {
    const first = decision();
    const second = decision();
    const question = decision();
    const onClose = vi.fn<() => void>();
    const { lastFrame, stdin } = render(
      <AsksCard
        asks={[
          ask({ key: 'a', title: 'fix the tests', decide: first }),
          ask({ key: 'b', title: 'docs pass', decide: second }),
          ask({ key: 'q', title: 'api migration', request: QUESTION, decide: question }),
        ]}
        columns={80}
        onClose={onClose}
      />,
    );
    await tick();
    await press(stdin, 'a');

    expect(lastFrame()).toContain('allow all 2 once? y/n');
    expect(first).not.toHaveBeenCalled();

    await press(stdin, 'y');
    expect(first).toHaveBeenCalledWith({ behavior: 'allow', scope: 'once' });
    expect(second).toHaveBeenCalledWith({ behavior: 'allow', scope: 'once' });
    expect(question).not.toHaveBeenCalled();
    // The interview is still parked, so the card is still up.
    expect(onClose).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('1 conversation is waiting on you');
  });

  it('backs out of the confirm row without deciding, and out of it alone', async () => {
    const decide = decision();
    const onClose = vi.fn<() => void>();
    const { lastFrame, stdin } = render(
      <AsksCard
        asks={[ask({ key: 'a', title: 'fix the tests', decide }), ask({ key: 'b', title: 'docs pass' })]}
        columns={80}
        onClose={onClose}
      />,
    );
    await tick();
    await press(stdin, 'N', ESC);

    expect(decide).not.toHaveBeenCalled();
    // Esc answered the confirmation, not the card.
    expect(onClose).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('2 conversations are waiting on you');

    await press(stdin, 'N', 'y');
    expect(decide).toHaveBeenCalledWith({ behavior: 'deny', message: DEFAULT_DENIAL });
  });

  it('closes on Esc and decides nothing — the other card denies, this one must not', async () => {
    const first = decision();
    const second = decision();
    const onClose = vi.fn<() => void>();
    const { stdin } = render(
      <AsksCard
        asks={[
          ask({ key: 'a', title: 'fix the tests', decide: first }),
          ask({ key: 'b', title: 'docs pass', decide: second }),
        ]}
        columns={80}
        onClose={onClose}
      />,
    );
    await tick();
    await press(stdin, UP, ESC);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('closes itself once the last row is answered', async () => {
    const onClose = vi.fn<() => void>();
    const { lastFrame, stdin } = render(
      <AsksCard
        asks={[ask({ key: 'a', title: 'fix the tests' }), ask({ key: 'b', title: 'docs pass' })]}
        columns={80}
        onClose={onClose}
      />,
    );
    await tick();
    await press(stdin, 'y', 'y');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toBe('');
  });
});
