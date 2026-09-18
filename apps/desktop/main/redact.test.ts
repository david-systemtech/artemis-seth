import { describe, expect, it } from 'vitest';

import {
  assertNoSecrets,
  assertResponseSafe,
  EVENT_SCAN_POLICY,
  looksLikeSecretValue,
  RESPONSE_SCAN_POLICY,
  scrubSecrets,
  SecretLeakError,
} from './redact.js';

/**
 * These tests are the executable version of Artemis's central invariant: a
 * secret never crosses IPC into the renderer. If the tripwire stops firing,
 * the invariant is being enforced by nothing but good intentions.
 */

const FAKE_KEY = 'sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCD';

describe('looksLikeSecretValue', () => {
  it('recognises the credential shapes Artemis can hold', () => {
    expect(looksLikeSecretValue(FAKE_KEY)).toBe(true);
    expect(looksLikeSecretValue('sk-0123456789abcdefghijklmnop')).toBe(true);
    expect(looksLikeSecretValue('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(looksLikeSecretValue('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')).toBe(true);
    expect(looksLikeSecretValue('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
  });

  it('leaves ordinary text alone', () => {
    expect(looksLikeSecretValue('Read src/index.ts')).toBe(false);
    expect(looksLikeSecretValue('sk-short')).toBe(false);
    // A masked hint is what the renderer is *supposed* to receive.
    expect(looksLikeSecretValue('sk-ant-...4f2a')).toBe(false);
  });

  it('does not read the tail of an ordinary word as the start of a key', () => {
    // The memory whose name refused the whole Instructions pane: "ta|sk-needs-
    // conhost-headless" is `sk-` and twenty-two key-legal characters.
    expect(looksLikeSecretValue('gamingpc-hidden-task-needs-conhost-headless')).toBe(false);
    expect(looksLikeSecretValue('banks/cortex/gamingpc-hidden-task-needs-conhost-headless.md')).toBe(false);
    // Every English word ending in "sk" is the same trap once it is kebab-cased.
    expect(looksLikeSecretValue('disk-usage-report-for-the-backup-volume')).toBe(false);
    expect(looksLikeSecretValue('risk-register-for-the-second-quarter')).toBe(false);
    expect(looksLikeSecretValue('a-mask-ant-colony-simulation-notes')).toBe(false);
  });

  it('still recognises a key wherever a key can really start', () => {
    const key = 'sk-0123456789abcdefghijklmnop';
    for (const carrier of [
      key,
      `OPENAI_API_KEY=${key}`,
      `"${key}"`,
      `key: ${key}`,
      `https://example.com/${key}`,
      `--token=${FAKE_KEY}`,
      `prefix-${key}`,
    ]) {
      expect(looksLikeSecretValue(carrier), carrier).toBe(true);
    }
  });
});

describe('scrubSecrets', () => {
  it('replaces credentials in log lines', () => {
    const scrubbed = scrubSecrets(`request failed with key ${FAKE_KEY}`);
    expect(scrubbed).not.toContain(FAKE_KEY);
    expect(scrubbed).toContain('[redacted]');
  });

  it('leaves a file name that merely contains "sk-" in the line', () => {
    const line = 'installed banks/cortex/gamingpc-hidden-task-needs-conhost-headless.md';
    expect(scrubSecrets(line)).toBe(line);
  });
});

describe('assertNoSecrets — response policy', () => {
  it('passes a well-formed ProfileMetadata list', () => {
    expect(() =>
      assertNoSecrets(
        {
          profiles: [
            { id: 'p1', label: 'Work', providerId: 'claude', backend: 'bedrock', keyHint: 'sk-ant-...4f2a' },
            { id: 'p2', label: 'Personal', providerId: 'claude', keyHint: null },
          ],
        },
        'artemis:profiles:list',
      ),
    ).not.toThrow();
  });

  it('catches a Profile returned where ProfileMetadata was expected', () => {
    // The exact refactor this module exists to prevent: someone returns the
    // stored record instead of its renderer-safe projection.
    const leaked = {
      profile: {
        id: 'p1',
        label: 'Work',
        providerId: 'claude',
        configDirName: 'work',
        secretRef: 'profile-abc',
        publicEnv: { ANTHROPIC_MODEL: 'claude-sonnet-4-6' },
      },
    };
    expect(() => assertNoSecrets(leaked, 'artemis:profiles:create')).toThrow(SecretLeakError);
  });

  it('catches a raw key smuggled into an unexpected field', () => {
    expect(() => assertNoSecrets({ run: { runId: 'r1', cwd: `/tmp/${FAKE_KEY}` } }, 'artemis:runs:start')).toThrow(
      SecretLeakError,
    );
  });

  it('does not fire on user text, which may legitimately contain anything', () => {
    // A user who pasted a key into a prompt still has to be able to see their
    // own session history.
    expect(() =>
      assertNoSecrets(
        { sessions: [{ id: 's1', title: `use ${FAKE_KEY} please`, updatedAt: 0 }], hasMore: false },
        'artemis:sessions:list',
      ),
    ).not.toThrow();
  });

  it('survives a cyclic payload instead of hanging', () => {
    const cyclic: Record<string, unknown> = { id: 'r1' };
    cyclic['self'] = cyclic;
    expect(() => assertNoSecrets(cyclic, 'test')).not.toThrow();
  });

  it('fails closed on a payload too deep to verify', () => {
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < RESPONSE_SCAN_POLICY.maxDepth + 4; i += 1) nested = { nested };
    expect(() => assertNoSecrets(nested, 'test')).toThrow(SecretLeakError);
  });
});

describe('assertNoSecrets — event policy', () => {
  it('lets model output through untouched', () => {
    // The agent explaining how to set an API key is normal transcript content.
    const event = {
      type: 'text.delta',
      runId: 'r1',
      seq: 4,
      ts: 0,
      messageId: 'm1',
      blockIndex: 0,
      text: `export ANTHROPIC_API_KEY=${FAKE_KEY}`,
    };
    expect(() => assertNoSecrets(event, 'push', EVENT_SCAN_POLICY)).not.toThrow();
  });

  it('does not walk into unbounded tool payloads', () => {
    const event = {
      type: 'tool.end',
      runId: 'r1',
      seq: 9,
      ts: 0,
      toolCallId: 't1',
      status: 'ok',
      result: { stdout: FAKE_KEY },
    };
    expect(() => assertNoSecrets(event, 'push', EVENT_SCAN_POLICY)).not.toThrow();
  });

  it('delivers a question that quotes a key shape, rather than parking the run on a prompt nobody saw', () => {
    // The agent's own words. A dropped `permission.request` is not a gap in a
    // transcript: the run waits on a prompt that was never drawn, and the wait
    // ends as a refusal the user never gave.
    const event = {
      type: 'permission.request',
      runId: 'r1',
      seq: 1,
      ts: 0,
      requestId: 'req-1',
      request: {
        id: 'req-1',
        runId: 'r1',
        toolName: 'AskUserQuestion',
        input: {},
        requestedAt: 0,
        question: {
          questions: [
            {
              question: `Send it as \`Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345\`, or as ${FAKE_KEY}?`,
              header: 'Auth header',
              multiSelect: false,
              options: [
                { label: 'Bearer', description: 'The header form.', preview: `curl -H "x-api-key: ${FAKE_KEY}"` },
                { label: 'Query', description: 'In the URL.' },
              ],
            },
          ],
        },
      },
    };

    expect(() => assertNoSecrets(event, 'agent-event', EVENT_SCAN_POLICY)).not.toThrow();
  });

  it('delivers a plan to approve, and what the person said back', () => {
    const plan = {
      type: 'permission.request',
      request: { id: 'req-2', toolName: 'ExitPlanMode', input: {}, plan: { plan: `1. Rotate ${FAKE_KEY}\n2. Redeploy` } },
    };
    const resolved = {
      type: 'permission.resolved',
      requestId: 'req-1',
      outcome: 'denied',
      note: `not with ${FAKE_KEY} in the URL`,
      answers: [{ question: 'Which header?', options: ['Bearer'], notes: `use ${FAKE_KEY} from the vault` }],
    };

    expect(() => assertNoSecrets(plan, 'agent-event', EVENT_SCAN_POLICY)).not.toThrow();
    expect(() => assertNoSecrets(resolved, 'agent-event', EVENT_SCAN_POLICY)).not.toThrow();
  });

  it('still refuses a profile field inside a question, at any depth', () => {
    const event = {
      type: 'permission.request',
      request: { question: { questions: [{ question: 'Which?', options: [{ label: 'A', publicEnv: {} }] }] } },
    };

    expect(() => assertNoSecrets(event, 'agent-event', EVENT_SCAN_POLICY)).toThrow(SecretLeakError);
  });

  it('still refuses a profile field on an event', () => {
    const event = { type: 'session.started', runId: 'r1', seq: 0, ts: 0, secretRef: 'profile-abc' };
    expect(() => assertNoSecrets(event, 'push', EVENT_SCAN_POLICY)).toThrow(SecretLeakError);
  });
});

/**
 * A replayed event is the same event. These are the regression tests for #68,
 * where reopening a session scanned its whole history as though Artemis had
 * written it — so a transcript that merely *mentioned* a key came back as
 * "Artemis blocked a response that failed its credential-safety check" and the
 * conversation appeared to be gone.
 */
describe('assertResponseSafe — replayed transcripts', () => {
  const textEvent = {
    type: 'text.delta',
    runId: 'r1',
    seq: 1,
    ts: 0,
    messageId: 'm1',
    blockIndex: 0,
    text: `export ANTHROPIC_API_KEY=${FAKE_KEY}`,
  };

  it('replays model output the live path already allows', () => {
    // The same event, both directions. If these two ever disagree, reopening a
    // session shows something different from watching it happen.
    expect(() => assertNoSecrets(textEvent, 'push', EVENT_SCAN_POLICY)).not.toThrow();
    expect(() => assertResponseSafe({ events: [textEvent], hasMore: false }, 'artemis:sessions:messages')).not.toThrow();
    expect(() => assertResponseSafe({ runId: 'r1', events: [textEvent] }, 'artemis:runs:events')).not.toThrow();
  });

  it('replays a tool call whose input names an environment', () => {
    // `env` is a forbidden *field name* on a payload Artemis assembles. Inside
    // a tool's input it is the agent describing a command it ran.
    const event = {
      type: 'tool.start',
      runId: 'r1',
      seq: 2,
      ts: 0,
      toolCallId: 't1',
      name: 'Bash',
      input: { command: 'npm test', env: { CI: '1' } },
    };
    expect(() => assertResponseSafe({ events: [event], hasMore: false }, 'artemis:sessions:messages')).not.toThrow();
  });

  it('does not charge one session against a budget sized for one event', () => {
    // Long enough to blow a single shared node budget several times over. The
    // ten-thousandth event is not more suspicious than the first.
    const events = Array.from({ length: 20_000 }, (_, i) => ({ ...textEvent, seq: i }));
    expect(() => assertResponseSafe({ events, hasMore: false }, 'artemis:sessions:messages')).not.toThrow();
  });

  it('still refuses a profile field smuggled onto a replayed event', () => {
    const event = { type: 'session.started', runId: 'r1', seq: 0, ts: 0, publicEnv: { ANTHROPIC_API_KEY: FAKE_KEY } };
    expect(() => assertResponseSafe({ events: [event], hasMore: false }, 'artemis:sessions:messages')).toThrow(
      SecretLeakError,
    );
  });

  it('still scans the envelope around the events strictly', () => {
    expect(() => assertResponseSafe({ events: [], hasMore: false, credentials: {} }, 'artemis:sessions:messages')).toThrow(
      SecretLeakError,
    );
  });

  it('falls back to the strict policy when `events` is not a list of events', () => {
    // The exemption is for the shape the protocol declares. Anything else goes
    // back through the front door.
    expect(() => assertResponseSafe({ events: { stdout: FAKE_KEY }, hasMore: false }, 'artemis:sessions:messages')).toThrow(
      SecretLeakError,
    );
  });
});

describe('assertResponseSafe — other content channels', () => {
  it('replays a terminal buffer without redacting the user their own screen', () => {
    // `cat .env` in the user's own shell, surviving a window reload.
    expect(() =>
      assertResponseSafe({ id: 't1', data: `ANTHROPIC_API_KEY=${FAKE_KEY}\r\n`, truncated: false }, 'artemis:terminal:replay'),
    ).not.toThrow();
  });

  it('opens a markdown file that documents a key', () => {
    expect(() =>
      assertResponseSafe(
        { kind: 'markdown', title: 'README.md', path: '/repo/README.md', bytes: 42, text: `Set \`${FAKE_KEY}\`` },
        'artemis:preview:open',
      ),
    ).not.toThrow();
  });

  it('leaves every other channel on the strict policy', () => {
    expect(() => assertResponseSafe({ run: { runId: 'r1', cwd: `/tmp/${FAKE_KEY}` } }, 'artemis:runs:start')).toThrow(
      SecretLeakError,
    );
  });
});

describe('assertResponseSafe — the prompt library', () => {
  /** What `agent-prompts:list` answers: the document, and the banks that preview a built-in. */
  const library = (over: { markdown?: string; index?: string; extra?: Record<string, unknown> } = {}) => ({
    document: {
      version: 1,
      prompts: [
        {
          id: 'prompt-1',
          name: 'House rules',
          markdown: over.markdown ?? 'Always branch before committing.',
          enabled: true,
          scope: { kind: 'all' },
          ...over.extra,
        },
      ],
    },
    memoryBanks: [
      {
        slug: 'cortex',
        isDefault: true,
        readonly: false,
        cli: '/usr/local/bin/cerebro',
        index: { text: over.index ?? '- [Unraid Paths](banks/cortex/unraid-paths.md)', indexed: 1, total: 1 },
      },
    ],
  });

  it('lists a standing prompt that tells the agent how to send a token', () => {
    // The user's own instructions, which is exactly where a header shape or a
    // key format gets written down. Refusing the listing hides the one row the
    // user would have to edit to make the refusal stop.
    const markdown = `Call the API with \`Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345\`, and never paste a real \`${FAKE_KEY}\` into a file.`;

    expect(() => assertResponseSafe(library({ markdown }), 'artemis:agent-prompts:list')).not.toThrow();
  });

  it('echoes it back from a save, so a saved prompt is not reported as a failure', () => {
    const markdown = 'Set `api_key: 0123456789abcdefghijklmnopqrstuvwxyz` in the fixture only.';

    expect(() =>
      assertResponseSafe({ document: library({ markdown }).document }, 'artemis:agent-prompts:save'),
    ).not.toThrow();
  });

  it('lists the library beside a bank whose index documents a key format', () => {
    // A team's memory names and descriptions, off the bank's reviewed branch.
    const index = `- [Rotating The Deploy Key](banks/cortex/rotating-the-deploy-key.md) — tokens look like ${FAKE_KEY}`;

    expect(() => assertResponseSafe(library({ index }), 'artemis:agent-prompts:list')).not.toThrow();
  });

  it('still refuses a profile field on a prompt, and a key in a field Artemis assembled', () => {
    expect(() =>
      assertResponseSafe(library({ extra: { apiKey: 'anything' } }), 'artemis:agent-prompts:list'),
    ).toThrow(SecretLeakError);
    expect(() =>
      assertResponseSafe(library({ extra: { id: FAKE_KEY } }), 'artemis:agent-prompts:list'),
    ).toThrow(SecretLeakError);
  });
});
