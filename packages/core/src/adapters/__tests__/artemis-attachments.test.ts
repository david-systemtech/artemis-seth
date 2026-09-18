/**
 * Sending a served conversation a screenshot.
 *
 * Until now it could not be done, and the reason the user was given was a
 * tooltip reading "Artemis does not support file attachments" — a statement
 * about the product, for what was a missing field on a request body. The
 * adapter declared neither `imageInput` nor `fileInput`, so the composer's
 * attach control was disabled against every served pane; and `send` took an
 * `attachments` argument and dropped it on the floor.
 *
 * What these pin is the pair of that fix and the thing it makes possible to get
 * wrong: a *newer client against an older server*. Every other field this
 * adapter sends degrades honestly when the server has never heard of it — the
 * run opens with the serving user's setting, which is a real outcome. An
 * attachment has no such degradation. Dropped, it leaves a question about a
 * picture in front of a model that never received it, and nothing anywhere says
 * so. So the adapter asks first, and refuses rather than sends.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Attachment } from '@rx-artemis/protocol';

import { ARTEMIS_CAPABILITIES, createArtemisAdapter } from '../artemis/adapter.js';
import { AdapterError } from '../types.js';
import type { ResolvedRunInput } from '../types.js';

const ENV = {
  ARTEMIS_LOCAL_BASE_URL: 'http://server.tail:6472',
  ARTEMIS_LOCAL_API_KEY: 'tok-123',
};

const SHOT: Attachment = {
  kind: 'image',
  id: 'img-1',
  mediaType: 'image/png',
  data: 'AAAA',
};

const INPUT = {
  runId: 'run-local',
  providerId: 'artemis',
  profileId: 'prof-a',
  cwd: '/w',
  model: 'work-max/opus',
  prompt: 'why is this misaligned?',
  attachments: [SHOT],
  env: ENV,
} as unknown as ResolvedRunInput;

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A finished turn, as one SSE stream. */
function sseResponse(): Response {
  const chunks = [
    {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'work-max/opus',
      choices: [{ index: 0, delta: { content: 'looking' }, finish_reason: null }],
      artemis: { runId: 'srv-run', seq: 0 },
    },
    {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'work-max/opus',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      artemis: { sessionId: 'sess-9', endReason: 'completed', seq: 1 },
    },
  ];
  const body = [...chunks.map((one) => `data: ${JSON.stringify(one)}\n\n`), 'data: [DONE]\n\n'];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of body) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/**
 * A server that answers `/connection` with whatever `acceptsAttachments` is
 * given, and everything else the way a working one would.
 */
function stubServer(options: { accepts?: boolean; connectionFails?: boolean } = {}) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const address = String(url);
      if (typeof init?.body === 'string') {
        sent.push({ url: address, body: JSON.parse(init.body) as Record<string, unknown> });
      }
      if (address.endsWith('/api/v0/connection')) {
        if (options.connectionFails === true) throw new Error('econnrefused');
        return jsonResponse({
          id: 'conn-1',
          label: 'Test',
          workspace: { kind: 'directory', path: '/w' },
          canRunTurns: true,
          manageProfiles: false,
          // Absent, not false, for a server too old to know the field — which
          // is exactly the shape the client has to read as "no".
          ...(options.accepts === true ? { acceptsAttachments: true } : {}),
        });
      }
      if (address.endsWith('/v1/chat/completions')) return sseResponse();
      if (address.includes('/api/v0/runs/srv-run/messages')) {
        return jsonResponse({ object: 'artemis.run.send', runId: 'srv-run', deliveredImmediately: true });
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${address}`);
    }),
  );
  return sent;
}

async function drain(run: { events: AsyncIterable<unknown> }): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of run.events) out.push(event);
  return out;
}

describe('what a served conversation says it can take', () => {
  it('claims both transports, because the wire has somewhere to put both', () => {
    // A statement about this transport, not about whatever the server routes
    // to: an account that cannot see a picture is refused per route, by the
    // server, with a 400 naming the account.
    expect(ARTEMIS_CAPABILITIES.imageInput).toBe(true);
    expect(ARTEMIS_CAPABILITIES.fileInput).toBe(true);
  });
});

describe('a prompt with an attachment, against a server that takes them', () => {
  it('asks first, then carries them on the request', async () => {
    const sent = stubServer({ accepts: true });
    const run = await createArtemisAdapter().createRun(INPUT);
    await drain(run);

    const request = sent.find((one) => one.url.endsWith('/v1/chat/completions'));
    expect((request?.body['artemis'] as { attachments?: unknown } | undefined)?.attachments).toEqual(
      [SHOT],
    );
  });

  it('carries them on a steer into the turn already going', async () => {
    const sent = stubServer({ accepts: true });
    const run = await createArtemisAdapter().createRun({
      ...INPUT,
      attachments: undefined,
    } as unknown as ResolvedRunInput);
    await drain(run);

    await run.send('and this one', [SHOT]);
    const steer = sent.find((one) => one.url.includes('/runs/srv-run/messages'));
    expect(steer?.body).toEqual({ text: 'and this one', attachments: [SHOT] });
  });
});

describe('a prompt with an attachment, against a server that would drop it', () => {
  it('refuses the run rather than asking about a picture it never sent', async () => {
    const sent = stubServer({ accepts: false });
    await expect(createArtemisAdapter().createRun(INPUT)).rejects.toThrow(AdapterError);
    // And nothing was sent: the refusal happens while there is still nothing on
    // the server's side of the link.
    expect(sent.some((one) => one.url.endsWith('/v1/chat/completions'))).toBe(false);
  });

  it('says which server, and that the files would have gone missing', async () => {
    stubServer({ accepts: false });
    await expect(createArtemisAdapter().createRun(INPUT)).rejects.toThrow(
      /too old to accept attachment/,
    );
  });

  it('refuses a steer against it too', async () => {
    // This run never had an attachment on its opening prompt, so nothing has
    // asked yet — and a pane that attached to a run in progress never builds a
    // request body at all.
    stubServer({ accepts: false });
    const run = await createArtemisAdapter().createRun({
      ...INPUT,
      attachments: undefined,
    } as unknown as ResolvedRunInput);
    await drain(run);
    await expect(run.send('and this one', [SHOT])).rejects.toThrow(/too old to accept/);
  });

  it('sends a prompt with no attachments without asking anything', async () => {
    const sent = stubServer({ accepts: false });
    const run = await createArtemisAdapter().createRun({
      ...INPUT,
      attachments: undefined,
    } as unknown as ResolvedRunInput);
    await drain(run);
    // The probe is the price of an attachment, and only of an attachment.
    expect(sent.some((one) => one.url.endsWith('/api/v0/connection'))).toBe(false);
  });
});

describe('a server that cannot be reached to ask', () => {
  it('refuses, because unreachable is not permission', async () => {
    stubServer({ connectionFails: true });
    await expect(createArtemisAdapter().createRun(INPUT)).rejects.toThrow(/Could not reach/);
  });
});
