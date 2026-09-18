/**
 * Attachments, over the wire.
 *
 * A served conversation could not be sent a screenshot, and the reasons were
 * spread across four files: the completions request had no field to put one in,
 * the steer route deliberately dropped the field it did have, the body cap
 * refused anything over a megabyte with a message about JSON, and the client
 * adapter never sent them at all. These pin the four halves that live here.
 *
 * The rule they are all shapes of: **an attachment is refused or delivered,
 * never dropped**. A prompt whose subject went missing is not a shorter prompt,
 * it is a question about nothing, answered confidently and wrongly, with
 * nothing anywhere reporting that a file was meant to be there.
 */

import { describe, expect, it } from 'vitest';

import type { AgentEvent, Attachment, RunHandle, ServerModel } from '@rx-artemis/protocol';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';

import type { RunSource } from '../completions.js';

const MODEL: ServerModel = {
  route: 'work-max/opus',
  id: 'opus',
  label: 'Opus',
  note: '.',
  profileId: 'prof-a' as ServerModel['profileId'],
  profileSlug: 'work-max',
  profileLabel: 'Work Max',
  providerId: 'claude',
  thinkingLevels: [],
  adaptiveThinking: false,
  fastMode: false,
  ultracode: false,
};

const TOKEN = 'attach-token-0123456789abcdef0123456789';
const CONNECTION = {
  id: 'conn-1',
  label: 'Test',
  workspace: { kind: 'ephemeral' as const, perSession: true },
  token: TOKEN,
  createdAt: 0,
};

const CARRIES = { ...NO_CAPABILITIES, imageInput: true, fileInput: true };

function catalogueWith(capabilities: typeof NO_CAPABILITIES) {
  return {
    read: async () => [
      {
        id: 'prof-a' as ServerModel['profileId'],
        slug: 'work-max',
        label: 'Work Max',
        provider: { id: 'claude' as const, label: 'Claude', kind: 'hosted' as const },
        available: true,
        disabled: false,
        live: true,
        capabilities,
        models: [MODEL],
      },
    ],
    invalidate: () => undefined,
  };
}

/** Base64 for `n` bytes. */
const payload = (bytes: number): string => 'A'.repeat(Math.ceil(bytes / 3) * 4);

const image = (id = 'img-1', bytes = 12): Attachment => ({
  kind: 'image',
  id,
  mediaType: 'image/png',
  data: payload(bytes),
});

const LIVE = {
  runId: 'run-live',
  providerId: 'claude',
  profileId: 'prof-a',
  cwd: '/w',
  status: 'running',
  capabilities: CARRIES,
  sessionId: 'sess-9',
} as unknown as RunHandle;

/**
 * An engine that records what it was asked to run, and answers immediately.
 *
 * `live` decides whether it is already working on `sess-9`, which is what sends
 * a request down the steer path instead of the start path.
 */
function recordingSource(options: { live?: boolean } = {}) {
  const listeners = new Set<(event: AgentEvent) => void>();
  const started: { attachments?: readonly Attachment[]; prompt: string }[] = [];
  const sent: { text: string; attachments?: readonly Attachment[] }[] = [];
  const emitted: AgentEvent[] = [];

  /*
   * Retained as well as pushed, because a steered caller subscribes *after* the
   * send returns and catches up from the buffer — which is the ordering
   * `steerTurn` depends on, and a source that only pushed would leave the
   * stream waiting for an end it had already missed.
   */
  const finish = (runId: string): void => {
    queueMicrotask(() => {
      const events = [
        { runId, seq: 0, type: 'text.delta', text: 'ok' },
        { runId, seq: 1, type: 'run.end', reason: 'completed' },
      ] as unknown as AgentEvent[];
      for (const event of events) {
        emitted.push(event);
        for (const listener of listeners) listener(event);
      }
    });
  };

  const source = {
    startRun: async (input: { prompt: string; attachments?: readonly Attachment[] }) => {
      started.push(input);
      finish('run-1');
      return {
        runId: 'run-1',
        providerId: 'claude',
        profileId: 'prof-a',
        cwd: '/w',
        status: 'running',
        capabilities: CARRIES,
      } as unknown as RunHandle;
    },
    subscribe: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: async (_runId: string, text: string, attachments?: readonly Attachment[]) => {
      sent.push({ text, ...(attachments === undefined ? {} : { attachments }) });
      finish('run-live');
      return { deliveredImmediately: true };
    },
    listRuns: async () => (options.live === true ? [LIVE] : []),
    getRun: async () => (options.live === true ? LIVE : undefined),
    runEvents: async () => ({ events: [...emitted], truncated: false }),
    interrupt: async () => {},
    interruptRun: async () => ({ stillQueued: [] }),
    respondToPermission: async () => {},
    disposeRun: async () => {},
  } as unknown as RunSource;

  return Object.assign(source, { started, sent });
}

async function serve(
  source: RunSource,
  capabilities: typeof NO_CAPABILITIES = CARRIES,
): Promise<{ root: string; own: (runId: string) => void; close: () => Promise<void> }> {
  const { createArtemisServer } = await import('../http.js');
  const { createWorkspaceResolver } = await import('../workspaces.js');
  const { createRunDirectory } = await import('../runs.js');
  const directory = createRunDirectory({ runs: source, sweepIntervalMs: 0 });
  const server = createArtemisServer({
    port: 0,
    connections: () => [CONNECTION],
    version: '1.1.1',
    catalogue: catalogueWith(capabilities),
    runs: source,
    workspaces: createWorkspaceResolver(),
    runDirectory: directory,
  });
  const port = await server.listen();
  return {
    root: `http://127.0.0.1:${port}`,
    // A run belongs to the connection that started it, and the run routes
    // authorise against that record. These tests hand the connection a run it
    // did not start, which is what a `claim` is.
    own: (runId: string) => {
      directory.claim({ runId, connectionId: CONNECTION.id, permissions: true });
    },
    close: async () => {
      directory.close();
      await server.close();
    },
  };
}

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface Failure {
  readonly error: { readonly code: string; readonly message: string };
}

describe('a prompt that carries attachments', () => {
  it('carries `artemis.attachments` into the run', async () => {
    const source = recordingSource();
    const { root, close } = await serve(source);
    try {
      const response = await post(`${root}/v1/chat/completions`, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'why is this misaligned?' }],
        artemis: { attachments: [image()] },
      });
      expect(response.status).toBe(200);
      expect(source.started[0]?.attachments).toEqual([image()]);
    } finally {
      await close();
    }
  });

  it('reads an OpenAI `image_url` data URL as the same thing', async () => {
    // What an off-the-shelf client sends. It has no other option, and until now
    // the answer it got was a sentence in the prompt saying the image was gone.
    const source = recordingSource();
    const { root, close } = await serve(source);
    try {
      const response = await post(`${root}/v1/chat/completions`, {
        model: 'work-max/opus',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
      });
      expect(response.status).toBe(200);
      expect(source.started[0]?.attachments).toEqual([
        { kind: 'image', id: 'image-url-1', mediaType: 'image/png', data: 'AAAA' },
      ]);
      // And the text no longer apologises for an image the model is being shown.
      expect(source.started[0]?.prompt).toBe('what is this');
    } finally {
      await close();
    }
  });

  it('holds both ways of naming them to one ceiling', async () => {
    const source = recordingSource();
    const { root, close } = await serve(source);
    try {
      const response = await post(`${root}/v1/chat/completions`, {
        model: 'work-max/opus',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'and these' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
            ],
          },
        ],
        artemis: { attachments: [image('a'), image('b'), image('c')] },
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as Failure).error.message).toMatch(/at most 4 images/);
      expect(source.started).toEqual([]);
    } finally {
      await close();
    }
  });

  it('refuses an account whose provider cannot see a picture, naming it', async () => {
    // A server fronts several providers and they do not agree; a llama.cpp
    // route behind a served account has nowhere to put an image. Refused here
    // rather than dropped, and refused with the route in the sentence.
    const source = recordingSource();
    const { root, close } = await serve(source, NO_CAPABILITIES);
    try {
      const response = await post(`${root}/v1/chat/completions`, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'look' }],
        artemis: { attachments: [image()] },
      });
      expect(response.status).toBe(400);
      const failure = (await response.json()) as Failure;
      expect(failure.error.code).toBe('unsupported_parameter');
      expect(failure.error.message).toContain('work-max/opus');
      expect(source.started).toEqual([]);
    } finally {
      await close();
    }
  });

  it('refuses a malformed attachment rather than running the prompt without it', async () => {
    const source = recordingSource();
    const { root, close } = await serve(source);
    try {
      const response = await post(`${root}/v1/chat/completions`, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'look' }],
        artemis: { attachments: [{ ...image(), data: 'not base64!' }] },
      });
      expect(response.status).toBe(400);
      const failure = (await response.json()) as Failure;
      expect(failure.error.code).toBe('invalid_body');
      expect(failure.error.message).toContain('artemis.attachments');
      expect(source.started).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe('a message into a run already going', () => {
  it('carries attachments on the steer route', async () => {
    // "Here is the screenshot I meant", mid-turn. The route used to take the
    // text and drop the file.
    const source = recordingSource({ live: true });
    const { root, own, close } = await serve(source);
    own('run-live');
    try {
      const response = await post(`${root}/api/v0/runs/run-live/messages`, {
        text: 'this one',
        attachments: [image()],
      });
      expect(response.status).toBe(200);
      expect(source.sent).toEqual([{ text: 'this one', attachments: [image()] }]);
    } finally {
      await close();
    }
  });

  it('refuses a malformed one on the steer route too', async () => {
    const source = recordingSource({ live: true });
    const { root, own, close } = await serve(source);
    own('run-live');
    try {
      const response = await post(`${root}/api/v0/runs/run-live/messages`, {
        text: 'this one',
        attachments: [{ ...image(), data: 'not base64!' }],
      });
      expect(response.status).toBe(400);
      expect(source.sent).toEqual([]);
    } finally {
      await close();
    }
  });

  it('carries them when a completions request steers a live conversation', async () => {
    const source = recordingSource({ live: true });
    const { root, close } = await serve(source);
    try {
      const response = await post(`${root}/v1/chat/completions`, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'this one' }],
        artemis: { sessionId: 'sess-9', attachments: [image()] },
      });
      expect(response.status).toBe(200);
      expect(source.sent[0]?.attachments).toEqual([image()]);
      expect(source.started).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe('the body cap', () => {
  it('lets an attachment-sized body through on the route that carries them', async () => {
    // Two megabytes: an ordinary screenshot, and under the old flat cap a `400`
    // saying the body had to be a JSON object.
    const source = recordingSource();
    const { root, close } = await serve(source);
    try {
      const response = await post(`${root}/v1/chat/completions`, {
        model: 'work-max/opus',
        messages: [{ role: 'user', content: 'why is this misaligned?' }],
        artemis: { attachments: [image('big', 2 * 1024 * 1024)] },
      });
      expect(response.status).toBe(200);
      expect(source.started[0]?.attachments?.[0]?.id).toBe('big');
    } finally {
      await close();
    }
  });

  it('answers 413 on a route that carries none, before it looks at the token', async () => {
    const source = recordingSource();
    const { root, close } = await serve(source);
    try {
      const response = await fetch(`${root}/api/v0/runs/run-1/permission`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ padding: 'x'.repeat(1_200_000) }),
      });
      expect(response.status).toBe(413);
      const failure = (await response.json()) as Failure;
      expect(failure.error.code).toBe('payload_too_large');
      // The cap is named, which is how a caller learns the wide one exists.
      expect(failure.error.message).toContain('1000000');
    } finally {
      await close();
    }
  });
});
