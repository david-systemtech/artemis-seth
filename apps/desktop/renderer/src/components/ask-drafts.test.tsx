/**
 * @vitest-environment jsdom
 *
 * A half-given answer outlives the card it was given on.
 *
 * Reported on 2026-09-19: options clicked on an agent's question, a switch to
 * another session before sending, and every choice gone on the way back. The
 * cards held their drafts in `useState`. A session switch moves the column's
 * pane aside — kept, with its run still parked — but unmounts everything drawn
 * in it, so the card drawn on return started from nothing. Hiding the pinned
 * strip above the prompt box lost them the same way without leaving at all.
 *
 * The draft now lives against the request (`lib/askDrafts.ts`). These pin that
 * it outlives the card for all three kinds of ask — a question's picks and
 * notes, an approval's reason, a plan's note — and that it goes once the
 * request has settled, wherever the answer came from.
 *
 * Unmounting the composer stands in for the switch: it is what the switch does
 * to the card, since the live card is pinned in the composer and the whole
 * column leaves the grid. The bridge is faked at `window.artemis`, as the card
 * tests do, so answers go through the real store and the real queue.
 * `renderer/tsconfig.json` excludes this file, so the assertions are
 * behavioural.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { IpcResult, PermissionDecision, PermissionRequest } from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';
import { forgetParkedAsks } from '@/components/ParkedAsks';
import { forgetAskDrafts, recallAskDraft } from '@/lib/askDrafts';
import { forgetFolds } from '@/lib/foldMemory';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

let sent: PermissionDecision[];
const respond = (request: string): IpcResult<{ requestId: string }> => ({
  ok: true,
  value: { requestId: request },
});

Object.defineProperty(globalThis, 'artemis', {
  configurable: true,
  value: {
    version: 'test',
    platform: 'darwin',
    profiles: {},
    providers: {},
    sessions: {},
    runs: {
      respondToPermission: async ({
        requestId,
        decision,
      }: {
        requestId: string;
        decision: PermissionDecision;
      }) => {
        sent.push(decision);
        return respond(requestId);
      },
    },
  },
});

const { Composer } = await import('@/components/Composer');
const { handleAgentEvent, resetRunStreamState } = await import('@/state/store');
const { appTranscript, seedApp } = await import('@/state/testkit');

const CAPABILITIES = {
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  permissionModes: ['default', 'plan'],
  resumeSession: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
  imageInput: true,
  fileInput: true,
};

/** One single-select and one multi-select, so both kinds of pick are covered. */
const QUESTION: PermissionRequest = {
  id: 'run_1:perm:1',
  runId: 'run_1',
  toolName: 'AskUserQuestion',
  input: {},
  requestedAt: 1_000,
  question: {
    questions: [
      {
        question: 'Which date library?',
        header: 'Library',
        multiSelect: false,
        options: [{ label: 'date-fns' }, { label: 'Luxon' }],
      },
      {
        question: 'Which checks should run?',
        header: 'Checks',
        multiSelect: true,
        options: [{ label: 'lint' }, { label: 'types' }, { label: 'tests' }],
      },
    ],
  },
};

const APPROVAL: PermissionRequest = {
  id: 'run_1:perm:2',
  runId: 'run_1',
  toolName: 'Bash',
  input: { command: 'rm -rf build' },
  title: 'Artemis wants to run a shell command',
  requestedAt: 2_000,
};

const PLAN: PermissionRequest = {
  id: 'run_1:perm:3',
  runId: 'run_1',
  toolName: 'ExitPlanMode',
  input: {},
  requestedAt: 3_000,
  plan: { plan: '# The plan\n\n1. Rewrite the parser.\n' },
};

function setUp(): void {
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Test Provider',
        capabilities: CAPABILITIES,
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [{ id: 'p1', label: 'P', providerId: 'claude', configDir: '/Users/me/.claude' }],
    activeProfileId: 'p1',
    capabilities: CAPABILITIES,
    cwd: '/w',
    draft: '',
    permissionQueue: [],
    banners: [],
    promptHistory: [],
    suggestion: null,
    run: {
      runId: 'run_1',
      status: 'running',
      providerId: 'claude',
      profileId: 'p1',
      cwd: '/w',
      capabilities: CAPABILITIES,
      startedAt: 0,
      sessionId: 'sess-1',
      promptsSent: 1,
    },
  } as never);
}

/** The agent parks on a request: the event the wire delivers. */
function park(request: PermissionRequest, seq: number): void {
  act(() => {
    handleAgentEvent({
      type: 'permission.request',
      runId: 'run_1',
      seq,
      ts: request.requestedAt,
      requestId: request.id,
      request,
    } as never);
    appTranscript().flush();
  });
}

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

/** Away to another conversation and back: the card is unmounted and drawn again. */
function switchAwayAndBack(): void {
  cleanup();
  mount(<Composer />);
}

const checked = (role: 'radio' | 'checkbox', name: RegExp): string | null =>
  screen.getByRole(role, { name }).getAttribute('aria-checked');

/** The note field under each question, in the order the questions are asked. */
const notes = (): HTMLTextAreaElement[] =>
  screen.getAllByPlaceholderText(/Sent alongside your choice/) as HTMLTextAreaElement[];

beforeEach(() => {
  sent = [];
  forgetAskDrafts();
  forgetFolds();
  forgetParkedAsks();
  resetRunStreamState();
  appTranscript().reset();
  setUp();
});

afterEach(cleanup);

describe('a half-answered question', () => {
  it('keeps its picks and notes across a session switch, and sends them', async () => {
    park(QUESTION, 1);
    mount(<Composer />);
    fireEvent.click(screen.getByRole('radio', { name: /Luxon/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /tests/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /lint/ }));
    fireEvent.change(notes()[1]!, { target: { value: 'Skip the slow suite.' } });

    switchAwayAndBack();

    expect(checked('radio', /Luxon/)).toBe('true');
    expect(checked('radio', /date-fns/)).toBe('false');
    expect(checked('checkbox', /tests/)).toBe('true');
    expect(checked('checkbox', /lint/)).toBe('true');
    expect(checked('checkbox', /types/)).toBe('false');
    expect(notes()[1]!.value).toBe('Skip the slow suite.');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send answers/ }));
    });
    const decision = sent[0];
    expect(decision?.behavior === 'allow' ? decision.answers : undefined).toEqual([
      { question: 'Which date library?', options: ['Luxon'] },
      {
        question: 'Which checks should run?',
        options: ['lint', 'tests'],
        notes: 'Skip the slow suite.',
      },
    ]);
  });

  it('keeps its picks while the pinned strip is hidden', () => {
    park(QUESTION, 1);
    mount(<Composer />);
    fireEvent.click(screen.getByRole('radio', { name: /Luxon/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));

    expect(checked('radio', /Luxon/)).toBe('true');
  });

  it('keeps its picks when the queue is emptied and the request parked again', () => {
    /*
      What re-attaching to a served run does: `attachRun` empties the pane's
      queue and the replay parks the same request, under the server's same id,
      into it again. Nothing about that settled the question.
    */
    park(QUESTION, 1);
    mount(<Composer />);
    fireEvent.click(screen.getByRole('radio', { name: /Luxon/ }));

    act(() => {
      seedApp({ permissionQueue: [] });
    });
    expect(screen.queryByRole('radio', { name: /Luxon/ })).toBeNull();
    park(QUESTION, 2);

    expect(checked('radio', /Luxon/)).toBe('true');
  });
});

describe('a half-written note on the other two asks', () => {
  it('keeps an approval’s denial reason, and sends it', async () => {
    park(APPROVAL, 1);
    mount(<Composer />);
    fireEvent.change(screen.getByLabelText(/reason for denial/i), {
      target: { value: 'Not the build directory.' },
    });

    switchAwayAndBack();

    expect((screen.getByLabelText(/reason for denial/i) as HTMLTextAreaElement).value).toBe(
      'Not the build directory.',
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    });
    expect(sent[0]).toMatchObject({ behavior: 'deny', message: 'Not the build directory.' });
  });

  it('keeps a plan’s note', () => {
    park(PLAN, 1);
    mount(<Composer />);
    fireEvent.change(screen.getByLabelText(/what to change/i), {
      target: { value: 'Do step 2 first.' },
    });

    switchAwayAndBack();

    expect((screen.getByLabelText(/what to change/i) as HTMLTextAreaElement).value).toBe(
      'Do step 2 first.',
    );
  });
});

describe('once the request has settled', () => {
  it('forgets the draft of an answer that was sent', async () => {
    park(QUESTION, 1);
    mount(<Composer />);
    fireEvent.click(screen.getByRole('radio', { name: /Luxon/ }));
    expect(recallAskDraft(QUESTION.id)).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send answers/ }));
    });

    expect(recallAskDraft(QUESTION.id)).toBeUndefined();
  });

  it('forgets it when the answer came from somewhere else', () => {
    // Another window, or the server's own record of an answer given elsewhere.
    park(QUESTION, 1);
    mount(<Composer />);
    fireEvent.click(screen.getByRole('radio', { name: /Luxon/ }));

    act(() => {
      handleAgentEvent({
        type: 'permission.resolved',
        runId: 'run_1',
        seq: 2,
        ts: 5_000,
        requestId: QUESTION.id,
        outcome: 'allowed',
      } as never);
    });

    expect(recallAskDraft(QUESTION.id)).toBeUndefined();
  });

  it('leaves the other requests’ drafts alone', async () => {
    park(QUESTION, 1);
    park(APPROVAL, 2);
    mount(<Composer />);
    fireEvent.click(screen.getByRole('radio', { name: /Luxon/ }));
    fireEvent.change(screen.getByLabelText(/reason for denial/i), {
      target: { value: 'Not the build directory.' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    });

    expect(recallAskDraft(APPROVAL.id)).toBeUndefined();
    expect(checked('radio', /Luxon/)).toBe('true');
  });
});
