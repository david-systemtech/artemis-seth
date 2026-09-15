import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

import type { PermissionDecision, PermissionRequest } from '@rx-artemis/protocol';

import { DEFAULT_DENIAL, PermissionCard } from './PermissionCard.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

/*
 * The bytes a terminal really sends, named — the card is answered with keys,
 * so the tests press keys rather than calling handlers.
 */
const ENTER = '\r';
const ESC = '\u001B';
const TAB = '\t';
const DOWN = '\u001B[B';
const CTRL_U = '\u0015';

/** Keystrokes in order, a tick apart, as Ink delivers them. */
const press = async (stdin: { write: (data: string) => void }, ...keys: readonly string[]): Promise<void> => {
  for (const key of keys) {
    stdin.write(key);
    await tick();
  }
};

/** What the card hands back: a decision, and sometimes a steer to follow it. */
const spy = (): ReturnType<typeof vi.fn<(d: PermissionDecision, followUp?: string) => void>> =>
  vi.fn<(d: PermissionDecision, followUp?: string) => void>();

const base: PermissionRequest = {
  id: 'req' as never,
  runId: 'run' as never,
  toolName: 'Bash',
  input: { command: 'rm -rf build' },
  title: 'Run rm -rf build',
  requestedAt: 0,
  suggestions: [
    { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }], scope: 'session' },
  ],
};

describe('PermissionCard', () => {
  it('shows the provider sentence and opens on Deny, so a bare Enter never authorises', async () => {
    const onDecision = vi.fn<(d: PermissionDecision) => void>();
    const { lastFrame, stdin } = render(<PermissionCard request={base} onDecision={onDecision} />);
    await tick();
    expect(lastFrame()).toContain('Run rm -rf build');
    expect(lastFrame()).toContain('❯ Deny');
    expect(lastFrame()).toContain('Allow always: Bash(rm:*)');

    stdin.write('\r');
    await tick();
    expect(onDecision).toHaveBeenCalledWith({ behavior: 'deny', message: expect.any(String) });
  });

  it('Esc denies', async () => {
    const onDecision = vi.fn<(d: PermissionDecision) => void>();
    const { stdin } = render(<PermissionCard request={base} onDecision={onDecision} />);
    await tick();
    stdin.write('');
    await tick();
    expect(onDecision.mock.calls[0]?.[0]?.behavior).toBe('deny');
  });

  it('echoes the chosen suggestion back as a session-scoped rule update', async () => {
    const onDecision = vi.fn<(d: PermissionDecision) => void>();
    const { stdin } = render(<PermissionCard request={base} onDecision={onDecision} />);
    await tick();
    stdin.write('[B'); // Allow once
    await tick();
    stdin.write('[B'); // Allow always
    await tick();
    stdin.write('\r');
    await tick();
    expect(onDecision).toHaveBeenCalledWith({
      behavior: 'allow',
      scope: 'session',
      updatedPermissions: base.suggestions,
    });
  });

  it('renders a plan as a plan, with approval carrying the suggested mode change', async () => {
    const onDecision = vi.fn<(d: PermissionDecision) => void>();
    const request: PermissionRequest = {
      ...base,
      toolName: 'ExitPlanMode',
      input: {},
      plan: { plan: '# Steps\n\n- do the thing' },
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', scope: 'session' }],
    };
    const { lastFrame, stdin } = render(<PermissionCard request={request} onDecision={onDecision} />);
    await tick();
    expect(lastFrame()).toContain('Plan');
    expect(lastFrame()).toContain('do the thing');
    expect(lastFrame()).toContain('❯ Think again');
    stdin.write('[B');
    await tick();
    stdin.write('\r');
    await tick();
    expect(onDecision).toHaveBeenCalledWith({ behavior: 'allow', updatedPermissions: request.suggestions });
  });

  it('walks a question and answers by allowing; Esc skips with no answers', async () => {
    const onDecision = vi.fn<(d: PermissionDecision) => void>();
    const request: PermissionRequest = {
      ...base,
      toolName: 'AskUserQuestion',
      input: {},
      question: {
        questions: [
          {
            question: 'Which database?',
            header: 'Database',
            multiSelect: false,
            options: [
              { label: 'Postgres', description: 'relational' },
              { label: 'SQLite', description: 'embedded', preview: '**not markdown**' },
            ],
          },
        ],
      },
    };
    const { lastFrame, stdin } = render(<PermissionCard request={request} onDecision={onDecision} />);
    await tick();
    expect(lastFrame()).toContain('Which database?');
    stdin.write('[B');
    await tick();
    // The preview is model-authored and shown as plain text.
    expect(lastFrame()).toContain('**not markdown**');
    stdin.write('\r');
    await tick();
    expect(onDecision).toHaveBeenCalledWith({
      behavior: 'allow',
      answers: [{ question: 'Which database?', options: ['SQLite'] }],
    });

    const skip = vi.fn<(d: PermissionDecision) => void>();
    const second = render(<PermissionCard request={request} onDecision={skip} />);
    await tick();
    second.stdin.write('');
    await tick();
    expect(skip).toHaveBeenCalledWith({ behavior: 'allow', answers: [] });
  });

  it('Tab on Deny opens a line for the reason, and that reason is what the model is told', async () => {
    const onDecision = spy();
    const { lastFrame, stdin } = render(<PermissionCard request={base} onDecision={onDecision} />);
    await tick();
    expect(lastFrame()).toContain('Tab comment');

    await press(stdin, TAB);
    expect(lastFrame()).toContain('why?');
    // The one place on this card where Esc is not a denial says so while it is.
    expect(lastFrame()).toContain('Esc closes the line and does not deny');

    await press(stdin, 'build/ is mine, delete the dist folder instead', ENTER);
    expect(onDecision).toHaveBeenCalledWith({
      behavior: 'deny',
      message: 'build/ is mine, delete the dist folder instead',
    });
  });

  it('a line left empty falls back to the sentence a denial always sent', async () => {
    const onDecision = spy();
    const { stdin } = render(<PermissionCard request={base} onDecision={onDecision} />);
    await tick();
    await press(stdin, TAB, ENTER);
    expect(onDecision).toHaveBeenCalledWith({ behavior: 'deny', message: DEFAULT_DENIAL });
  });

  it('Tab on Allow once hands the follow-up back beside the decision, not inside it', async () => {
    const onDecision = spy();
    const { lastFrame, stdin } = render(<PermissionCard request={base} onDecision={onDecision} />);
    await tick();
    await press(stdin, DOWN, TAB);
    expect(lastFrame()).toContain('and then…');

    await press(stdin, 'then run the tests', ENTER);
    expect(onDecision).toHaveBeenCalledWith({ behavior: 'allow', scope: 'once' }, 'then run the tests');
  });

  it('Esc in the line closes the line and decides nothing; the words are kept and Esc after it denies', async () => {
    const onDecision = spy();
    const { lastFrame, stdin } = render(<PermissionCard request={base} onDecision={onDecision} />);
    await tick();
    await press(stdin, TAB, 'not while the server is up', ESC);
    expect(onDecision).not.toHaveBeenCalled();
    expect(lastFrame()).not.toContain('why?');
    expect(lastFrame()).toContain('❯ Deny');

    await press(stdin, ESC);
    expect(onDecision).toHaveBeenCalledWith({ behavior: 'deny', message: 'not while the server is up' });
  });

  it('shows the rule a suggestion would save and where it would be saved', async () => {
    const onDecision = spy();
    const { lastFrame } = render(<PermissionCard request={base} onDecision={onDecision} />);
    await tick();
    expect(lastFrame()).toContain('Bash(rm:*) · for this session');
  });

  it('e narrows the rule before it is saved, and the decision carries what was read', async () => {
    const onDecision = spy();
    const { lastFrame, stdin } = render(<PermissionCard request={base} onDecision={onDecision} />);
    await tick();
    await press(stdin, DOWN, DOWN);
    expect(lastFrame()).toContain('e edit · s scope');

    await press(stdin, 'e');
    expect(lastFrame()).toContain('✎ rm:*');
    await press(stdin, CTRL_U, 'rm build:*', ENTER);
    // Enter in the rule line keeps the edit; it does not answer the request.
    expect(onDecision).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('Bash(rm build:*) · for this session');

    await press(stdin, ENTER);
    expect(onDecision).toHaveBeenCalledWith({
      behavior: 'allow',
      scope: 'session',
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Bash', ruleContent: 'rm build:*' }],
          scope: 'session',
        },
      ],
    });
  });

  it('Esc in the rule line abandons the edit', async () => {
    const onDecision = spy();
    const { lastFrame, stdin } = render(<PermissionCard request={base} onDecision={onDecision} />);
    await tick();
    await press(stdin, DOWN, DOWN, 'e', CTRL_U, 'everything', ESC);
    expect(lastFrame()).toContain('Bash(rm:*) · for this session');
    expect(lastFrame()).not.toContain('Bash(everything)');

    await press(stdin, ENTER);
    expect(onDecision).toHaveBeenCalledWith({
      behavior: 'allow',
      scope: 'session',
      updatedPermissions: base.suggestions,
    });
  });

  it('s walks the scope the rule is remembered at', async () => {
    const onDecision = spy();
    const { lastFrame, stdin } = render(<PermissionCard request={base} onDecision={onDecision} />);
    await tick();
    await press(stdin, DOWN, DOWN, 's');
    expect(lastFrame()).toContain('Bash(rm:*) · saved to local settings');
    await press(stdin, 's');
    expect(lastFrame()).toContain('Bash(rm:*) · saved to project settings');

    await press(stdin, ENTER);
    expect(onDecision).toHaveBeenCalledWith({
      behavior: 'allow',
      scope: 'session',
      updatedPermissions: [
        { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }], scope: 'project' },
      ],
    });
  });

  it('a rule that is only a tool name has nothing to edit, and e does nothing', async () => {
    const onDecision = spy();
    const request: PermissionRequest = {
      ...base,
      suggestions: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Read' }], scope: 'session' }],
    };
    const { lastFrame, stdin } = render(<PermissionCard request={request} onDecision={onDecision} />);
    await tick();
    await press(stdin, DOWN, DOWN);
    expect(lastFrame()).toContain('Read · for this session');
    expect(lastFrame()).toContain('s scope');
    expect(lastFrame()).not.toContain('e edit');

    await press(stdin, 'e');
    expect(lastFrame()).not.toContain('✎');

    await press(stdin, ENTER);
    expect(onDecision).toHaveBeenCalledWith({
      behavior: 'allow',
      scope: 'session',
      updatedPermissions: request.suggestions,
    });
  });

  it('the plan card sends what to change back with Think again', async () => {
    const onDecision = spy();
    const request: PermissionRequest = {
      ...base,
      toolName: 'ExitPlanMode',
      input: {},
      plan: { plan: '# Steps\n\n- rewrite the loader' },
      suggestions: [],
    };
    const { lastFrame, stdin } = render(<PermissionCard request={request} onDecision={onDecision} />);
    await tick();
    expect(lastFrame()).toContain('Tab comment');

    await press(stdin, TAB);
    expect(lastFrame()).toContain('what should change?');
    await press(stdin, 'keep the loader, change the cache', ENTER);
    expect(onDecision).toHaveBeenCalledWith({
      behavior: 'deny',
      message: 'Keep planning; keep the loader, change the cache',
    });
  });
});
