/**
 * The `RunInput` a bridge token is allowed to compose.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * `POST /api/v0/runs` accepts a whole {@link RunInput} on purpose — the holder
 * of a bridge token is the *user*, not a program borrowing an account, and a
 * remote window that could not choose its own permission mode would be a lesser
 * Artemis. But "the user's own settings" is a statement about which knobs are
 * offered, not a licence to hand the adapters whatever JSON arrived on a
 * socket, and the first version of this route did exactly that: it checked four
 * fields were non-empty strings and then `return raw as RunInput`.
 *
 * That cast was the bug. `RunInput.additionalDirectories` is passed straight
 * through to the Claude SDK's `additionalDirectories` and into Codex's
 * `writableRoots`, so a token pinned to one repository could post
 * `additionalDirectories: ["/"]` and hand the agent the whole filesystem as a
 * declared writable root — with the pin still "enforced" on `cwd`, and the
 * refusal that was supposed to be the token's whole authority story silently
 * stepped around. Every other unvalidated field rode the same cast: a
 * `systemPrompt` of any size, a `metadata` object of any depth, a `maxTurns` of
 * any sign.
 *
 * The local IPC path has never had this problem, because every renderer request
 * crosses `validate.ts`, which builds a `RunInput` key by key from an explicit
 * allowlist and copies nothing else. The wire had no equivalent. This file is
 * that equivalent, and it is deliberately a near-mirror of `validateRunInput`
 * rather than a cleverer scheme: two boundaries onto the same engine that
 * disagree about what is acceptable are how one of them ends up more permissive
 * than anybody intended, which is the sentence this whole file is about.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT COPIED
 * ---------------------------------------------------------------------------
 *
 * Only the keys written below survive. That is the rule, and it is why an
 * unknown field added upstream tomorrow cannot reach an adapter through this
 * route before somebody has thought about it — the failure mode is a setting
 * quietly not applying, which is visible, rather than a grant quietly widening,
 * which is not.
 *
 * `fastMode`, `ultracode`, `chromeBrowser` and `externalBrowser` are absent
 * here, and no longer for the reason this used to give. They were absent from
 * `validate.ts` too - dropped on the local path, which turned out to be a bug
 * and not a policy: four switches drawn in the window that no run ever heard
 * of. The window carries them now. This route still does not, each for a
 * reason of its own: `externalBrowser` describes the *host's* browser tools and
 * a server has no window to open; `chromeBrowser` connects a run to the serving
 * account owner's Chrome, which needs the operator's say, and the route that
 * asks for it is `/v1/chat/completions` (`artemis.chromeBrowser`, see
 * `ServerContext.allowChromeBrowser`); `fastMode` and `ultracode` travel there
 * too, gated per route by the catalogue this route never reads.
 *
 * ---------------------------------------------------------------------------
 * PATHS ARE VALIDATED HERE AND CONFINED BY THE CALLER
 * ---------------------------------------------------------------------------
 *
 * This file proves `cwd` (when the caller sends one — see {@link
 * ParsedRunInput}) and every `additionalDirectories` entry is an absolute
 * path of sane length. It does *not* know the connection's pin, so it does not
 * decide whether they are allowed — the route does that, running every one of
 * them through the same confinement, so that a path-bearing field cannot reach
 * an adapter by a route the pin never saw. Keeping the two jobs apart is what
 * makes "which fields carry paths" a single readable list here rather than
 * knowledge spread across the router.
 */

import type { Attachment, JsonObject, RunInput, SystemPromptSpec } from '@rx-artemis/protocol';
import {
  AttachmentError,
  isPermissionMode,
  isProviderEffort,
  isProviderId,
  readAttachments,
} from '@rx-artemis/protocol';

/**
 * Bounds, mirroring `validate.ts`'s `LIMITS` for the fields this accepts.
 *
 * Duplicated rather than shared because `validate.ts` lives in the desktop's
 * main process and this package is test-enforced free of it. The numbers are
 * the contract; a drift between them is a bug in whichever moved.
 */
const LIMITS = {
  id: 200,
  label: 200,
  prompt: 1_000_000,
  systemPrompt: 200_000,
  path: 4_096,
  model: 200,
  toolName: 200,
  toolListItems: 512,
  directoryItems: 64,
  maxTurns: 1_000,
  maxBudgetUsd: 10_000,
  metadataNodes: 256,
  metadataDepth: 8,
  // Attachments are bounded by `ATTACHMENT_LIMITS` in protocol, which is where
  // the composer and the IPC boundary read them from too. A second opinion here
  // is the drift this file's header is about.
} as const;

/** Raised for a body this route will not build a run out of. */
export class RunInputError extends Error {
  constructor(
    readonly field: string,
    detail: string,
  ) {
    super(`\`${field}\` ${detail}.`);
    this.name = 'RunInputError';
  }
}

/* -------------------------------------------------------------------------- */
/* Field readers                                                              */
/* -------------------------------------------------------------------------- */

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RunInputError(field, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new RunInputError(field, 'must be a string');
  if (value.length > max) throw new RunInputError(field, `must be at most ${max} characters`);
  return value;
}

function requireString(value: unknown, field: string, max: number): string {
  const read = optionalString(value, field, max);
  if (read === undefined) throw new RunInputError(field, 'is required');
  return read;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new RunInputError(field, 'must be a boolean');
  return value;
}

function optionalInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RunInputError(field, 'must be a whole number');
  }
  if (value < min || value > max) {
    throw new RunInputError(field, `must be between ${min} and ${max}`);
  }
  return value;
}

function optionalFiniteNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RunInputError(field, 'must be a finite number');
  }
  if (value < min || value > max) {
    throw new RunInputError(field, `must be between ${min} and ${max}`);
  }
  return value;
}

function optionalStringArray(
  value: unknown,
  field: string,
  maxItems: number,
  maxLength: number,
): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new RunInputError(field, 'must be an array of strings');
  if (value.length > maxItems) {
    throw new RunInputError(field, `must hold at most ${maxItems} entries`);
  }
  return value.map((entry, index) => requireString(entry, `${field}[${index}]`, maxLength));
}

/** An absolute path of sane length. Confinement to the pin is the route's job. */
function requireAbsolutePath(value: unknown, field: string): string {
  const path = requireString(value, field, LIMITS.path);
  if (!path.startsWith('/')) throw new RunInputError(field, 'must be an absolute path');
  // A NUL truncates the string in every syscall that receives it, so a path
  // carrying one is not the path that was validated.
  if (path.includes('\0')) throw new RunInputError(field, 'must not contain a NUL byte');
  return path;
}

/** {@link requireAbsolutePath}, for a field the caller may honestly omit. */
function optionalAbsolutePath(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireAbsolutePath(value, field);
}

function optionalAbsolutePathArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new RunInputError(field, 'must be an array of paths');
  if (value.length > LIMITS.directoryItems) {
    throw new RunInputError(field, `must hold at most ${LIMITS.directoryItems} entries`);
  }
  return value.map((entry, index) => requireAbsolutePath(entry, `${field}[${index}]`));
}

/**
 * A bounded JSON object: no functions, no cycles, no unbounded nesting.
 *
 * Counted as well as depth-limited because breadth costs as much as depth on
 * the way through `JSON.stringify` and back out to a renderer.
 */
function optionalJsonObject(value: unknown, field: string): JsonObject | undefined {
  if (value === undefined || value === null) return undefined;
  const root = requireObject(value, field);
  let nodes = 0;
  const walk = (node: unknown, depth: number, at: string): void => {
    if (depth > LIMITS.metadataDepth) {
      throw new RunInputError(at, `must not nest deeper than ${LIMITS.metadataDepth}`);
    }
    nodes += 1;
    if (nodes > LIMITS.metadataNodes) {
      throw new RunInputError(field, `must hold at most ${LIMITS.metadataNodes} values`);
    }
    if (node === null) return;
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, depth + 1, `${at}[${index}]`));
      return;
    }
    switch (typeof node) {
      case 'string':
      case 'number':
      case 'boolean':
        return;
      case 'object':
        for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
          walk(entry, depth + 1, `${at}.${key}`);
        }
        return;
      default:
        throw new RunInputError(at, 'must be JSON');
    }
  };
  walk(root, 0, field);
  return root as JsonObject;
}

/**
 * The system prompt, as the tagged union the protocol actually declares.
 *
 * Bounded hard: `text` is the one field on this input whose whole purpose is to
 * be a large block of prose, and an unbounded one is a way to spend somebody's
 * plan without ever writing a prompt. The `kind` is closed rather than passed
 * through, because an unrecognised one reaching an adapter is a run whose
 * system prompt silently did nothing.
 */
function optionalSystemPrompt(value: unknown, field: string): SystemPromptSpec | undefined {
  if (value === undefined || value === null) return undefined;
  const spec = requireObject(value, field);
  const kind = requireString(spec['kind'], `${field}.kind`, 16);
  switch (kind) {
    case 'default':
      return { kind: 'default' };
    case 'append':
    case 'replace':
      return { kind, text: requireString(spec['text'], `${field}.text`, LIMITS.systemPrompt) };
    default:
      throw new RunInputError(`${field}.kind`, 'must be "default", "append" or "replace"');
  }
}

/**
 * Attachments, read by the one reader every boundary uses.
 *
 * This used to be its own validator, and being its own validator is how it
 * ended up wrong in a way nobody noticed: it admitted thirty-two entries of
 * twenty megabytes each with no per-kind ceiling, no request total and no check
 * that the payload was base64 at all, while the IPC boundary a few files away
 * enforced all four. Both are doors onto the same adapters. The only reason the
 * gap never mattered is that a one-megabyte body cap made every attachment on
 * this route impossible, which is a defence that stopped being one the moment
 * the cap was widened for exactly this feature.
 *
 * So the rules live in `readAttachments`, in protocol, next to the limits they
 * enforce, and this is the two lines that re-throw its refusal as this route's
 * own error type.
 */
function optionalAttachments(value: unknown, field: string): readonly Attachment[] | undefined {
  try {
    return readAttachments(value, field);
  } catch (error) {
    if (error instanceof AttachmentError) throw new RunInputError(error.field, error.detail);
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* The allowlist                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A validated body, with `cwd` still open.
 *
 * `cwd` is the one field the route completes rather than the caller: the pin
 * decides where a run is rooted, so a caller may omit it — a Windows client's
 * local directory names a path on the wrong machine, and "the pin, wherever
 * that is" is the only honest thing such a caller can say. Omitted means
 * absent or `null`, the same pair every optional field here accepts. When
 * present it is held to the serving side's rule (absolute, POSIX) and
 * confined to the pin by the route.
 */
export type ParsedRunInput = Omit<RunInput, 'cwd'> & { readonly cwd?: string };

/**
 * Build a run input out of a request body, copying only what is written here.
 *
 * @throws {RunInputError} with a field name and a sentence, which the route
 *   turns into a 400. The caller learns which field it got wrong, because a
 *   bare "invalid body" against a twenty-field object is not a diagnosis.
 */
export function readRunInput(body: unknown): ParsedRunInput {
  const outer = requireObject(body, 'body');
  const input = requireObject(outer['input'], 'input');

  const providerId = input['providerId'];
  if (!isProviderId(providerId)) throw new RunInputError('input.providerId', 'is not a known provider');

  const permissionMode = input['permissionMode'];
  if (permissionMode !== undefined && permissionMode !== null && !isPermissionMode(permissionMode)) {
    throw new RunInputError('input.permissionMode', 'is not a known permission mode');
  }

  const effort = input['effort'];
  if (effort !== undefined && effort !== null && !isProviderEffort(effort)) {
    throw new RunInputError('input.effort', 'is not a valid reasoning-effort id');
  }

  /*
   * An empty prompt is legitimate — resuming a session to let the agent carry
   * on is a real workflow — so this is length-checked rather than required to
   * be non-empty, matching `validate.ts`.
   */
  const prompt = input['prompt'];
  if (typeof prompt !== 'string') throw new RunInputError('input.prompt', 'must be a string');
  if (prompt.length > LIMITS.prompt) {
    throw new RunInputError('input.prompt', `must be at most ${LIMITS.prompt} characters`);
  }

  const draft: Record<string, unknown> = {
    providerId,
    profileId: requireString(input['profileId'], 'input.profileId', LIMITS.id),
    cwd: optionalAbsolutePath(input['cwd'], 'input.cwd'),
    prompt,
    attachments: optionalAttachments(input['attachments'], 'input.attachments'),
    runId: optionalString(input['runId'], 'input.runId', LIMITS.id),
    resumeSessionId: optionalString(input['resumeSessionId'], 'input.resumeSessionId', LIMITS.id),
    forkSession: optionalBoolean(input['forkSession'], 'input.forkSession'),
    rewindToMessageId: optionalString(
      input['rewindToMessageId'],
      'input.rewindToMessageId',
      LIMITS.model,
    ),
    model: optionalString(input['model'], 'input.model', LIMITS.model),
    fallbackModel: optionalString(input['fallbackModel'], 'input.fallbackModel', LIMITS.model),
    permissionMode: permissionMode === null ? undefined : permissionMode,
    effort: effort === null ? undefined : effort,
    allowedTools: optionalStringArray(
      input['allowedTools'],
      'input.allowedTools',
      LIMITS.toolListItems,
      LIMITS.toolName,
    ),
    disallowedTools: optionalStringArray(
      input['disallowedTools'],
      'input.disallowedTools',
      LIMITS.toolListItems,
      LIMITS.toolName,
    ),
    additionalDirectories: optionalAbsolutePathArray(
      input['additionalDirectories'],
      'input.additionalDirectories',
    ),
    maxTurns: optionalInteger(input['maxTurns'], 'input.maxTurns', 1, LIMITS.maxTurns),
    maxBudgetUsd: optionalFiniteNumber(
      input['maxBudgetUsd'],
      'input.maxBudgetUsd',
      0,
      LIMITS.maxBudgetUsd,
    ),
    systemPrompt: optionalSystemPrompt(input['systemPrompt'], 'input.systemPrompt'),
    title: optionalString(input['title'], 'input.title', LIMITS.label),
    includePartialMessages: optionalBoolean(
      input['includePartialMessages'],
      'input.includePartialMessages',
    ),
    metadata: optionalJsonObject(input['metadata'], 'input.metadata'),
  };

  // Absent stays absent: a key present with `undefined` is not the same as a
  // key that was never sent once it reaches an adapter that spreads it.
  for (const key of Object.keys(draft)) {
    if (draft[key] === undefined) delete draft[key];
  }
  return draft as unknown as ParsedRunInput;
}

/**
 * Every path on a validated input, with the field name each came from.
 *
 * The route confines these against the connection's pin. Returned as a list
 * rather than confined here so that "which fields carry paths" is stated once,
 * beside the allowlist that admits them, and a path-bearing field added to that
 * list without being added to this one is a visibly incomplete change.
 */
export function pathsOf(
  input: ParsedRunInput,
): readonly { readonly field: string; readonly path: string }[] {
  return [
    ...(input.cwd === undefined ? [] : [{ field: 'input.cwd', path: input.cwd }]),
    ...(input.additionalDirectories ?? []).map((path, index) => ({
      field: `input.additionalDirectories[${index}]`,
      path,
    })),
  ];
}
