import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_WIRE_BYTES,
  AttachmentError,
  mergeAttachments,
  readAttachments,
} from './attachment.js';

/** Base64 for `n` bytes, standard alphabet and correct padding. */
const payload = (bytes: number): string => 'A'.repeat(Math.ceil(bytes / 3) * 4);

const image = (id: string, bytes = 12): unknown => ({
  kind: 'image',
  id,
  mediaType: 'image/png',
  data: payload(bytes),
});

const file = (id: string, bytes = 12): unknown => ({
  kind: 'file',
  id,
  name: 'report.csv',
  data: payload(bytes),
});

describe('readAttachments', () => {
  it('reads both kinds, keeping only the fields the type declares', () => {
    expect(
      readAttachments(
        [
          { ...(image('a') as object), name: 'shot.png', width: 10, height: 20, extra: 'dropped' },
          { ...(file('b') as object), mediaType: 'text/csv' },
        ],
        'attachments',
      ),
    ).toEqual([
      {
        kind: 'image',
        id: 'a',
        mediaType: 'image/png',
        data: payload(12),
        name: 'shot.png',
        width: 10,
        height: 20,
      },
      { kind: 'file', id: 'b', name: 'report.csv', mediaType: 'text/csv', data: payload(12) },
    ]);
  });

  it('reads nothing sent and nothing in the array as the same answer', () => {
    // Both have to reach the adapters identically, because neither is an
    // attachment and a caller should not have to know which shape means it.
    expect(readAttachments(undefined, 'attachments')).toBeUndefined();
    expect(readAttachments(null, 'attachments')).toBeUndefined();
    expect(readAttachments([], 'attachments')).toBeUndefined();
  });

  it('refuses a payload that is not base64', () => {
    // `Buffer.from` would happily decode this into something nobody predicted.
    expect(() => readAttachments([{ ...(file('a') as object), data: 'not base64!' }], 'a')).toThrow(
      /must be base64/,
    );
  });

  it('refuses a data: prefix rather than stripping it', () => {
    expect(() =>
      readAttachments([{ ...(image('a') as object), data: 'data:image/png;base64,AAAA' }], 'a'),
    ).toThrow(/must be base64/);
  });

  it('refuses an image format no provider reads as an image', () => {
    expect(() =>
      readAttachments([{ ...(image('a') as object), mediaType: 'image/heic' }], 'a'),
    ).toThrow(/must be one of/);
  });

  it('refuses an id that could be a path', () => {
    expect(() => readAttachments([image('../etc/passwd')], 'a')).toThrow(/valid identifier/);
  });

  it('requires a file to be named, because the staged file is named after it', () => {
    const { name: _name, ...unnamed } = file('a') as { name: string };
    expect(() => readAttachments([unnamed], 'a')).toThrow(/`a\[0\].name`/);
  });

  it('holds each kind to its own ceiling', () => {
    const images = Array.from({ length: ATTACHMENT_LIMITS.images + 1 }, (_, n) =>
      image(`i${String(n)}`),
    );
    expect(() => readAttachments(images, 'a')).toThrow(/at most 4 images/);

    const files = Array.from({ length: ATTACHMENT_LIMITS.files + 1 }, (_, n) =>
      file(`f${String(n)}`),
    );
    expect(() => readAttachments(files, 'a')).toThrow(/at most 10 files/);
  });

  it('bounds one payload and the request as a whole', () => {
    expect(() =>
      readAttachments([image('a', ATTACHMENT_LIMITS.bytesPerImage + 4)], 'a'),
    ).toThrow(/must decode to at most/);

    // Three files each comfortably under the per-file ceiling, and over the
    // request's together: the arithmetic the per-payload check cannot do. One
    // payload string, shared, so the test does not allocate it three times.
    const third = Math.ceil(ATTACHMENT_LIMITS.bytesTotal / 3) + 1024;
    const data = payload(third);
    expect(third).toBeLessThan(ATTACHMENT_LIMITS.bytesPerFile);
    expect(() =>
      readAttachments(
        ['a', 'b', 'c'].map((id) => ({ kind: 'file', id, name: 'big.log', data })),
        'a',
      ),
    ).toThrow(/bytes in total/);
  });

  it('refuses two attachments sharing an id', () => {
    expect(() => readAttachments([image('a'), file('a')], 'a')).toThrow(/same id/);
  });

  it('names the field and the entry that was wrong', () => {
    try {
      readAttachments([image('a'), { kind: 'sound', id: 'b' }], 'input.attachments');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AttachmentError);
      expect((error as AttachmentError).field).toBe('input.attachments[1].kind');
    }
  });
});

describe('mergeAttachments', () => {
  it('returns the other side untouched when one is empty', () => {
    const one = readAttachments([image('a')], 'a');
    expect(mergeAttachments(one, undefined, 'a')).toBe(one);
    expect(mergeAttachments(undefined, one, 'a')).toBe(one);
    expect(mergeAttachments([], one, 'a')).toBe(one);
  });

  it('refuses a pair that breaks a ceiling each half was under', () => {
    // The case this function exists for: `artemis.attachments` and `image_url`
    // parts are each legal, and together they are three images too many.
    const artemis = [image('a'), image('b'), image('c')];
    const parts = [image('d'), image('e')];
    expect(
      readAttachments(artemis, 'a')?.length === 3 && readAttachments(parts, 'b')?.length === 2,
    ).toBe(true);
    expect(() =>
      mergeAttachments(readAttachments(artemis, 'a'), readAttachments(parts, 'b'), 'a'),
    ).toThrow(/at most 4 images/);
  });
});

describe('ATTACHMENT_WIRE_BYTES', () => {
  it('leaves room for everything one prompt is allowed to carry', () => {
    // Derived rather than picked, so a change to the product limit moves the
    // wire cap with it instead of silently making the limit unreachable.
    expect(ATTACHMENT_WIRE_BYTES).toBeGreaterThan((ATTACHMENT_LIMITS.bytesTotal * 4) / 3);
  });
});
