/**
 * Things sent alongside a prompt.
 *
 * Two kinds, and the split is not cosmetic — it is the difference between two
 * ways of getting something in front of a model.
 *
 * ## Images go *into* the prompt; files go *next to* it
 *
 * An **image** becomes a content block on the wire. The model sees the pixels
 * as part of the message, because there is no other way for it to see them:
 * neither provider has a tool that can look at a picture.
 *
 * A **file** is staged to disk and named in the prompt, and the agent opens it
 * with the tools it already has. That is the whole mechanism, and it is the
 * right one for a coding agent for a reason worth writing down: inlining a 5MB
 * CSV costs on the order of a million tokens and *answers worse* than letting
 * the agent run `head` on it, infer the schema, and grep the twelve rows that
 * matter. The agent reading the file is not a fallback for not being able to
 * send it — it is the better outcome.
 *
 * PDFs are where both are true at once. Claude's `document` block gives the
 * model vision over the rendered pages — layout, tables, charts, scanned text —
 * which no amount of reading the file as bytes recovers. So a PDF sent to
 * Claude is *both*: a document block for the eyes, and a staged path for the
 * tools. See `stageAttachments` in `@rx-artemis/core`.
 *
 * ## Bytes, not paths
 *
 * Both kinds carry their own base64 payload rather than a path the main process
 * would read. Two reasons, and the first is the one that matters:
 *
 *  1. **A path from the renderer is a request to read an arbitrary file.** The
 *     renderer is sandboxed and cannot open `~/.ssh/id_rsa`; if it could ask
 *     the main process to attach that path to a prompt, it would have got there
 *     anyway, by a route with no user in it. Bytes keep the boundary where it
 *     is: the renderer can only send what the OS already handed it through a
 *     paste, a drop or a file picker — every one of which is a user gesture.
 *  2. Pasted images have no path to begin with, so a path-shaped protocol would
 *     need a second shape for the most common case.
 *
 * Electron's `webUtils.getPathForFile` would give a real path for a dropped
 * file without that first problem — the renderer cannot fabricate a `File` for
 * a path the user did not choose. It is still not what this does, because the
 * agent has to be able to *read* wherever the file lives: honouring the
 * original path means granting the agent the user's whole Downloads folder,
 * where staging a copy grants it one temp directory holding exactly the files
 * that were attached.
 *
 * The cost is that everything crosses IPC as base64 and sits in memory twice
 * for the length of the call, which is why {@link ATTACHMENT_LIMITS} exists and
 * is enforced at the boundary rather than left to good behaviour upstream.
 */

/* -------------------------------------------------------------------------- */
/* Images                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Image formats every supported provider can read as an image.
 *
 * The intersection of what the Anthropic Messages API accepts and what the
 * models behind Codex accept, which is the same four. Anything else — HEIC off
 * an iPhone, a TIFF, a PSD — is not rejected: it is simply *not an image* as
 * far as this app is concerned, and rides along as a file instead, which is a
 * better answer than refusing it.
 *
 * SVG's absence is deliberate rather than an oversight: it is a document that
 * can carry script and fetch remote resources, and no provider treats it as an
 * image. As a file it is exactly what it is — text the agent can read.
 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** Runtime type guard for {@link ImageMediaType}. */
export function isImageMediaType(value: unknown): value is ImageMediaType {
  return typeof value === 'string' && (IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

/**
 * PDF, named once.
 *
 * The one media type that is neither an image nor plain text to a provider, and
 * the only file kind that gets a native content block as well as a staged path.
 */
export const PDF_MEDIA_TYPE = 'application/pdf';

/**
 * One image travelling with a prompt.
 *
 * `id` is minted by the renderer and is what the transcript keys its thumbnail
 * off, so an attachment stays identifiable after the send without the renderer
 * having to match on payloads.
 */
export interface ImageAttachment {
  readonly kind: 'image';
  readonly id: string;
  readonly mediaType: ImageMediaType;
  /**
   * Base64, standard alphabet, no `data:` prefix and no whitespace — exactly
   * what the Anthropic Messages API's `source.data` wants, so no consumer has
   * to strip a prefix it did not expect.
   */
  readonly data: string;
  /**
   * The file's own name, when it had one. Pasted images have none.
   *
   * A label for the user, and nothing else depends on it: it is not a path, it
   * is not unique, and image staging deliberately does not use it to name the
   * file it writes. Treat it as untrusted text — it came from a filename, which
   * can contain anything.
   */
  readonly name?: string;
  /** Pixel dimensions, when the renderer decoded them. Display only. */
  readonly width?: number;
  readonly height?: number;
}

/* -------------------------------------------------------------------------- */
/* Files                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One file travelling with a prompt, to be staged where the agent can read it.
 *
 * Any format at all. There is no allow-list, on purpose: the agent has `Read`,
 * `Grep` and a shell, so the set of files it can do something useful with is
 * far wider than any list this package could keep current, and a user who
 * attaches a `.parquet` or a `.sqlite` is better served by an agent that tries
 * than by a dialog explaining that the format is unsupported.
 */
export interface FileAttachment {
  readonly kind: 'file';
  readonly id: string;
  /**
   * The filename, and unlike an image's it is **load-bearing**: the staged file
   * is named after it, so the path the agent is given reads as
   * `…/quarterly-sales.csv` rather than `…/file-3`, and the agent knows what it
   * has before it opens anything.
   *
   * Which makes it the one field here an attacker upstream could shape into a
   * path, so it is sanitized to a single safe path component before it is used
   * — see `safeFileName` in `@rx-artemis/core`. Everything reading it for
   * display should still treat it as untrusted text.
   */
  readonly name: string;
  /**
   * The media type the OS reported, when it reported one. Advisory: browsers
   * routinely hand over an empty string for anything they do not recognise, and
   * the agent works out what a file is by reading it. Only
   * {@link PDF_MEDIA_TYPE} changes behaviour.
   */
  readonly mediaType?: string;
  /** Base64, standard alphabet, no `data:` prefix and no whitespace. */
  readonly data: string;
}

/* -------------------------------------------------------------------------- */
/* The union                                                                  */
/* -------------------------------------------------------------------------- */

/** Anything that can ride along with a prompt. Discriminate on `kind`. */
export type Attachment = ImageAttachment | FileAttachment;

/** Narrow an {@link Attachment} to the image case. */
export function isImageAttachment(value: Attachment): value is ImageAttachment {
  return value.kind === 'image';
}

/** Narrow an {@link Attachment} to the file case. */
export function isFileAttachment(value: Attachment): value is FileAttachment {
  return value.kind === 'file';
}

/** True for a file the providers can also render as a document block. */
export function isPdf(value: Attachment): value is FileAttachment {
  return value.kind === 'file' && value.mediaType === PDF_MEDIA_TYPE;
}

/* -------------------------------------------------------------------------- */
/* Limits                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Ceilings on what one prompt may carry.
 *
 * Product limits, not just guardrails: the composer enforces them *before* the
 * send so the user finds out while they can still do something about it, and
 * the main process enforces them again because a renderer is not a trusted
 * enforcer of its own limits.
 *
 * The two byte ceilings differ by an order of magnitude because the two kinds
 * are spent differently. An image's bytes become tokens in the request, so five
 * megabytes is already generous — and it is Anthropic's own per-image ceiling.
 * A file's bytes become a file on disk; nothing reads it unless the agent
 * chooses to, and a 30MB log is a perfectly reasonable thing to hand someone
 * whose first move will be to grep it. What bounds the file ceiling is the
 * base64 round-trip through IPC, not the model's context.
 */
export const ATTACHMENT_LIMITS = {
  /** How many images may ride along with one prompt. */
  images: 4,
  /** How many files may ride along with one prompt. */
  files: 10,
  /** Decoded bytes, per image. */
  bytesPerImage: 5 * 1024 * 1024,
  /** Decoded bytes, per file. */
  bytesPerFile: 32 * 1024 * 1024,
  /** Decoded bytes, summed across everything on a single prompt. */
  bytesTotal: 64 * 1024 * 1024,
  /** Characters of `name`. */
  nameLength: 200,
} as const;

/**
 * Decoded size of a base64 payload, without decoding it.
 *
 * Every size check in the app runs on this rather than on `data.length`, so the
 * number the user is shown, the number the composer refuses on and the number
 * the main process refuses on are all the same number.
 */
export function base64Bytes(data: string): number {
  if (data.length === 0) return 0;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** Decoded size of one attachment. @see base64Bytes */
export function attachmentBytes(attachment: Attachment): number {
  return base64Bytes(attachment.data);
}

/* -------------------------------------------------------------------------- */
/* Reading attachments off a boundary                                         */
/* -------------------------------------------------------------------------- */

/**
 * Why this reader lives in `protocol` rather than at each boundary.
 *
 * There are now four places an attachment can arrive from somewhere that is not
 * this process: the renderer over IPC (`validate.ts`), a bridge token posting a
 * whole `RunInput` (`server/runInput.ts`), a completions request carrying
 * `artemis.attachments`, and a steer into a run already going. Each used to be
 * free to decide what an attachment was, and the two that existed already
 * disagreed — the IPC path checked the base64 alphabet, the per-kind ceilings
 * and the request total, while the wire path checked a flat twenty megabytes
 * and nothing else, and got away with it only because a one-megabyte body cap
 * made every attachment on that route impossible anyway.
 *
 * That is the shape of bug `runInput.ts`'s own header is about: two boundaries
 * onto one engine that disagree about what is acceptable, until one of them
 * turns out to be more permissive than anybody intended. So there is one reader
 * and the boundaries differ only in which error type they re-throw — the
 * limits, the alphabet check and the per-kind arithmetic are stated once.
 */

/**
 * A rejected attachment, with the field that carried it.
 *
 * Its own error type rather than a boolean, because each boundary already has
 * an error shape of its own — `ValidationError` over IPC, `RunInputError` on
 * the bridge, an HTTP failure body on the completions route — and all three
 * want the same two strings to build it from.
 */
export class AttachmentError extends Error {
  constructor(
    readonly field: string,
    readonly detail: string,
  ) {
    super(`\`${field}\` ${detail}.`);
    this.name = 'AttachmentError';
  }
}

/**
 * The largest request body a route carrying attachments will read.
 *
 * Derived rather than picked, so it cannot drift from what the composer allows:
 * a prompt may carry {@link ATTACHMENT_LIMITS.bytesTotal} decoded, base64 adds
 * a third, and the rest of the request — the prompt text, the extensions, the
 * field names — gets a megabyte of its own.
 *
 * It is a great deal larger than the one-megabyte cap every other route keeps,
 * and the difference is the point: body size is the one resource an
 * authenticated caller controls directly, so the routes that have a reason to
 * need the room are the only routes given it.
 */
export const ATTACHMENT_WIRE_BYTES = Math.ceil(ATTACHMENT_LIMITS.bytesTotal / 3) * 4 + 1_048_576;

/**
 * Character set for an attachment's `id`.
 *
 * Wide enough for a uuid or a nanoid; narrow enough that an id can never be a
 * path, a shell fragment or a JSON injection. The same pattern the IPC boundary
 * has always applied to every id crossing it.
 */
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Characters of an attachment `id`. */
const ID_LENGTH = 200;

/** Characters of a file's advisory `mediaType`. */
const MEDIA_TYPE_LENGTH = 200;

/**
 * Base64, checked as a charset rather than by decoding.
 *
 * `Buffer.from(x, 'base64')` does not validate — it discards anything outside
 * the alphabet and returns whatever it managed to decode. A payload that is
 * half base64 and half something else would sail through a decode check and
 * reach the provider as a corrupt image, or reach `writeFile` in an adapter as
 * a file whose contents nobody predicted.
 *
 * Not one regex, deliberately. The obvious pattern is
 * `^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$`, where the
 * `{4}` group inside a `*` is what enforces the multiple-of-four length. That
 * is a **nested quantifier**, and V8 pushes a backtracking frame per repetition
 * — so on a payload of any real size it does not reject the input, it throws
 * `RangeError: Maximum call stack size exceeded`. That version shipped in the
 * image-only revision of the IPC validator and never fired, because five
 * megabytes of image was under the threshold; the first 8MB file found it.
 *
 * So the length rule is arithmetic and the charset rule is a flat character
 * class, which is linear and allocates no frames. `=` appears only in the
 * trailing `={0,2}`, so padding still cannot appear in the middle.
 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function isBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64_PATTERN.test(value);
}

function attachmentObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AttachmentError(field, 'must be an object');
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  // Structured clone and `JSON.parse` both produce `Object.prototype`-rooted
  // objects; anything else came from somewhere it should not have.
  if (proto !== Object.prototype && proto !== null) {
    throw new AttachmentError(field, 'must be a plain object');
  }
  return value as Record<string, unknown>;
}

function attachmentString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new AttachmentError(field, 'must be a string');
  if (value.length === 0) throw new AttachmentError(field, 'must not be empty');
  if (value.length > maxLength) {
    throw new AttachmentError(field, `must be at most ${String(maxLength)} characters`);
  }
  if (value.includes('\u0000')) throw new AttachmentError(field, 'must not contain NUL bytes');
  return value;
}

function optionalAttachmentString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return attachmentString(value, field, maxLength);
}

function attachmentId(value: unknown, field: string): string {
  const text = attachmentString(value, field, ID_LENGTH);
  if (!ATTACHMENT_ID_PATTERN.test(text)) {
    throw new AttachmentError(field, 'is not a valid identifier');
  }
  return text;
}

function optionalAttachmentInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AttachmentError(field, 'must be an integer');
  }
  if (value < min || value > max) {
    throw new AttachmentError(field, `must be between ${String(min)} and ${String(max)}`);
  }
  return value;
}

/**
 * The base64 payload both kinds carry.
 *
 * Size before shape: the charset scan is linear, but walking forty megabytes of
 * string before refusing it is work done for a payload that was never going to
 * be accepted.
 */
function attachmentPayload(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string') throw new AttachmentError(field, 'must be a string');
  if (value.length === 0) throw new AttachmentError(field, 'must not be empty');
  if (base64Bytes(value) > maxBytes) {
    throw new AttachmentError(field, `must decode to at most ${String(maxBytes)} bytes`);
  }
  if (!isBase64(value)) {
    throw new AttachmentError(field, 'must be base64 with no data: prefix');
  }
  return value;
}

/** Drop keys whose value is `undefined`, so a built attachment stays tidy. */
function compactAttachment<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

/** One image, read off a boundary. */
function readImageAttachment(value: unknown, field: string): ImageAttachment {
  const attachment = attachmentObject(value, field);

  const mediaType = attachment['mediaType'];
  if (!isImageMediaType(mediaType)) {
    throw new AttachmentError(
      `${field}.mediaType`,
      `must be one of ${IMAGE_MEDIA_TYPES.join(', ')}`,
    );
  }

  return compactAttachment<ImageAttachment>({
    kind: 'image',
    id: attachmentId(attachment['id'], `${field}.id`),
    mediaType,
    data: attachmentPayload(attachment['data'], `${field}.data`, ATTACHMENT_LIMITS.bytesPerImage),
    // A filename, so it is untrusted display text: length-capped like every
    // other label, and never used to build a path — staged images are named
    // after a counter for exactly this reason.
    name: optionalAttachmentString(
      attachment['name'],
      `${field}.name`,
      ATTACHMENT_LIMITS.nameLength,
    ),
    width: optionalAttachmentInteger(attachment['width'], `${field}.width`, 1, 1_000_000),
    height: optionalAttachmentInteger(attachment['height'], `${field}.height`, 1, 1_000_000),
  });
}

/**
 * One file, read off a boundary.
 *
 * No format check, deliberately — see {@link FileAttachment}. What is checked is
 * the one field that is *not* inert: `name` is required here (an image's is
 * optional) because the staged file is named after it, so a missing one is a
 * bug rather than a shrug. It is length-capped and NUL-checked, and
 * `safeFileName` in the core adapters reduces it to a single safe path
 * component before anything opens it. Two layers, because the consequence of
 * getting it wrong is a write outside the staging directory.
 */
function readFileAttachment(value: unknown, field: string): FileAttachment {
  const attachment = attachmentObject(value, field);

  return compactAttachment<FileAttachment>({
    kind: 'file',
    id: attachmentId(attachment['id'], `${field}.id`),
    name: attachmentString(attachment['name'], `${field}.name`, ATTACHMENT_LIMITS.nameLength),
    // Free-form: browsers hand over whatever they like, including nothing, and
    // only `application/pdf` changes any behaviour downstream. Bounded so it
    // cannot be used as a smuggling channel, and otherwise passed through.
    mediaType: optionalAttachmentString(
      attachment['mediaType'],
      `${field}.mediaType`,
      MEDIA_TYPE_LENGTH,
    ),
    data: attachmentPayload(attachment['data'], `${field}.data`, ATTACHMENT_LIMITS.bytesPerFile),
  });
}

/**
 * Every attachment on one prompt, or `undefined` for a prompt carrying none.
 *
 * Absent rather than `[]` when the list is empty, so a caller can spread the
 * result into an optional field without a branch, and so "the caller sent an
 * empty array" and "the caller sent nothing" reach the adapters identically —
 * which they must, because neither is an attachment.
 *
 * @throws {AttachmentError} for anything this will not accept.
 */
export function readAttachments(
  value: unknown,
  field: string,
): readonly Attachment[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new AttachmentError(field, 'must be an array');
  if (value.length === 0) return undefined;
  // A cheap bound before anything is measured, so a caller sending ten thousand
  // entries is refused by a length check rather than by a loop.
  const maxEntries = ATTACHMENT_LIMITS.images + ATTACHMENT_LIMITS.files;
  if (value.length > maxEntries) {
    throw new AttachmentError(field, `must have at most ${String(maxEntries)} entries`);
  }

  const attachments = value.map((entry, index): Attachment => {
    const at = `${field}[${String(index)}]`;
    const kind = attachmentObject(entry, at)['kind'];
    if (kind === 'image') return readImageAttachment(entry, at);
    if (kind === 'file') return readFileAttachment(entry, at);
    throw new AttachmentError(`${at}.kind`, 'must be "image" or "file"');
  });

  // Per kind, because the two have different ceilings for different reasons —
  // an image's bytes become tokens, a file's become a file.
  const images = attachments.filter(isImageAttachment).length;
  if (images > ATTACHMENT_LIMITS.images) {
    throw new AttachmentError(field, `must have at most ${String(ATTACHMENT_LIMITS.images)} images`);
  }
  const files = attachments.length - images;
  if (files > ATTACHMENT_LIMITS.files) {
    throw new AttachmentError(field, `must have at most ${String(ATTACHMENT_LIMITS.files)} files`);
  }

  // The per-attachment ceilings bound one payload; this bounds the request. Ten
  // files each just under the limit is ten times the memory of one, held while
  // they are written to disk.
  const total = attachments.reduce((sum, attachment) => sum + attachmentBytes(attachment), 0);
  if (total > ATTACHMENT_LIMITS.bytesTotal) {
    throw new AttachmentError(
      field,
      `must decode to at most ${String(ATTACHMENT_LIMITS.bytesTotal)} bytes in total`,
    );
  }

  // Duplicate ids would make the transcript's chips ambiguous, and are never
  // something a composer produces.
  const ids = new Set(attachments.map((attachment) => attachment.id));
  if (ids.size !== attachments.length) {
    throw new AttachmentError(field, 'must not contain two attachments with the same id');
  }

  return attachments;
}

/**
 * Join two attachment lists and hold the result to the same limits.
 *
 * One request can name attachments twice — `artemis.attachments` beside an
 * OpenAI `image_url` part — and each list is legal on its own while the pair is
 * not. Re-reading the concatenation is the only check that catches that, and it
 * is cheap: the payloads have already been measured, and this walks them once
 * more rather than decoding anything.
 *
 * @throws {AttachmentError} when the combined list breaks a limit.
 */
export function mergeAttachments(
  first: readonly Attachment[] | undefined,
  second: readonly Attachment[] | undefined,
  field: string,
): readonly Attachment[] | undefined {
  if (first === undefined || first.length === 0) return second;
  if (second === undefined || second.length === 0) return first;
  return readAttachments([...first, ...second], field);
}
