/**
 * `artemis --print "<prompt>"` — one turn, no screen.
 *
 * The scripting face of the same engine: start a run, write what the assistant
 * says to stdout, exit with a code that says how it went. Tool activity goes to
 * stderr so a pipe sees only the answer.
 *
 * Three shapes for stdout, chosen with `--output-format`:
 *
 *  - `text`        — the assistant's prose as it streams. For a person.
 *  - `json`        — nothing until the end, then one object: what was said,
 *                    what it cost, how long it took, and the session it wrote
 *                    to, so the next call can `--resume` it.
 *  - `stream-json` — every protocol event as one JSON line as it arrives, then
 *                    that same final object as the last line. For a wrapper
 *                    that wants to watch the turn rather than wait for it.
 *
 * The two JSON modes always end with exactly one result line, including the
 * runs that fail before a provider is reached — a caller that reads the last
 * line gets an answer or a reason, never nothing.
 *
 * stderr is the same in all three: the same tool notices, the same refusals,
 * the same sentence when a run ends badly. Diagnostics are not part of the
 * format, so redirecting them away never changes what stdout means.
 *
 * Nobody is watching, so a permission prompt is **denied**, with a message
 * that tells the model why — the same rule the headless server applies on its
 * completions surface. Pre-authorise what unattended work needs through the
 * profile's own settings, or pass `--mode` explicitly; do not expect this path
 * to guess.
 *
 * Also the first thing that ran against a real provider while the UI was still
 * being built, and worth keeping for exactly that: it proves the engine seam
 * with nothing between it and the terminal.
 */

import type { AgentEvent, RunEndEvent, RunEndReason, SessionId, TokenUsage } from '@rx-artemis/protocol';
import { syncScheduler } from '@rx-artemis/transcript';

import { Conversation } from './conversation.js';
import type { Launched } from './launch.js';

const NOBODY_HOME =
  'This run was started with `artemis --print`, which has nobody to ask. Run interactively, or start with a permission mode that already allows this.';

export interface PrintIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** What `--output-format` accepts. */
export const OUTPUT_FORMATS = ['text', 'json', 'stream-json'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value);
}

/**
 * The last line of `--output-format json` and `stream-json`.
 *
 * Every field is always present, `null` standing in for what the provider did
 * not report, so a caller destructures one shape rather than branching on which
 * keys arrived. `usage` is the run's own `UsageSnapshot`, minus the parts that
 * describe the context window rather than the bill.
 */
export interface PrintResult {
  /** The provider session this turn wrote to — what `--resume` takes next time. */
  readonly sessionId: string | null;
  /** Everything the assistant said, joined, exactly as `text` would have printed it. */
  readonly text: string;
  readonly usage: { readonly tokens: TokenUsage; readonly costUsd: number | null };
  readonly durationMs: number;
  readonly reason: RunEndReason;
}

/** No provider reported any, so the shape is kept and the numbers are honest. */
const NO_TOKENS: TokenUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * What a finished run amounts to.
 *
 * Pure, and separate from the writing, because this is the part with a
 * contract: a run that never reached a provider has no `run.end` to summarise
 * and still owes the caller a line. Such a run reports `error` — it did not
 * complete, and `reason` is the field a script branches on.
 */
export function printResult(collected: {
  readonly text: string;
  readonly sessionId?: SessionId | undefined;
  readonly end?: RunEndEvent | undefined;
  readonly elapsedMs: number;
}): PrintResult {
  const { end } = collected;
  return {
    sessionId: end?.sessionId ?? collected.sessionId ?? null,
    text: collected.text,
    usage: { tokens: end?.usage?.tokens ?? NO_TOKENS, costUsd: end?.usage?.costUsd ?? null },
    // The provider's own measurement when it makes one: it timed the turn, and
    // this only timed the wait around it.
    durationMs: end?.durationMs ?? collected.elapsedMs,
    reason: end?.reason ?? 'error',
  };
}

/**
 * Everything that reaches stdout, in one place.
 *
 * The writer owns the format and nothing else — `runPrint` keeps the control
 * flow, the refusals and stderr — which is what makes all three modes testable
 * without a provider: hand it events and read what it wrote.
 */
export interface PrintWriter {
  /** Every event of the run, in the order it arrived. */
  event(event: AgentEvent): void;
  /** The final line. Nothing in `text` mode, and written at most once. */
  finish(): void;
}

export function createPrintWriter(format: OutputFormat, io: PrintIo, now: () => number = Date.now): PrintWriter {
  const startedAt = now();
  /** Message ids already seen as deltas, so a `text.complete` is not echoed twice. */
  const streamed = new Set<string>();
  let text = '';
  let sessionId: SessionId | undefined;
  let end: RunEndEvent | undefined;
  let finished = false;

  const say = (fragment: string): void => {
    if (format === 'text') io.stdout(fragment);
    else text += fragment;
  };

  return {
    event(event) {
      // The protocol event, verbatim: it is already JSON-shaped, and a
      // reshaping here would be a second schema to keep in step with the first.
      if (format === 'stream-json') io.stdout(`${JSON.stringify(event)}\n`);
      switch (event.type) {
        case 'session.started':
          sessionId = event.sessionId;
          break;
        case 'text.delta':
          if (event.agentId === undefined) {
            streamed.add(event.messageId);
            say(event.text);
          }
          break;
        case 'text.complete':
          // A non-streaming provider sends only this; a streaming one already
          // wrote every fragment and must not be echoed twice.
          if (event.role === 'assistant' && event.agentId === undefined && !streamed.has(event.messageId)) {
            say(event.text);
          }
          break;
        case 'run.end':
          end = event;
          // The answer ends with a newline, because a shell prompt should not
          // begin on the same line as one.
          if (format === 'text') io.stdout('\n');
          break;
        default:
          break;
      }
    },
    finish() {
      if (finished || format === 'text') return;
      finished = true;
      io.stdout(
        `${JSON.stringify(
          printResult({
            text,
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(end === undefined ? {} : { end }),
            elapsedMs: now() - startedAt,
          }),
        )}\n`,
      );
    },
  };
}

export interface PrintOptions {
  /** Defaults to `text`. */
  readonly format?: OutputFormat;
}

/** Resolves to the process exit code. */
export async function runPrint(launched: Launched, prompt: string, io: PrintIo, options: PrintOptions = {}): Promise<number> {
  const { host, settings } = launched;
  const writer = createPrintWriter(options.format ?? 'text', io);
  const conversation = new Conversation({
    driver: host.runs,
    settings,
    capabilitiesFor: (id) => host.capabilitiesFor(id),
    scheduler: syncScheduler,
  });

  let resolveEnd: (code: number) => void = () => undefined;
  const end = new Promise<number>((resolve) => {
    resolveEnd = resolve;
  });

  conversation.subscribeEvents((event) => {
    writer.event(event);
    switch (event.type) {
      case 'tool.start':
        io.stderr(`  ⚙ ${event.title ?? event.name}\n`);
        break;
      case 'permission.request':
        void conversation.respondToPermission(event.requestId, { behavior: 'deny', message: NOBODY_HOME });
        io.stderr(`  ⊘ denied: ${event.request.toolName} (nobody to ask)\n`);
        break;
      case 'run.end': {
        if (event.reason !== 'completed') {
          io.stderr(`run ended: ${event.reason.replace(/_/g, ' ')}${event.error !== undefined ? ` — ${event.error.message}` : ''}\n`);
        }
        resolveEnd(event.reason === 'completed' ? 0 : 1);
        break;
      }
      default:
        break;
    }
  });

  /*
   * Every way out writes the last line and lets the conversation go — the ones
   * that never reach a provider included, because a caller reading JSON is owed
   * a result even when the answer is that there was no run.
   */
  try {
    // `-c` / `--resume`: continue a stored conversation rather than open a new
    // one. Only the id is needed; nothing here draws the history.
    if (launched.resume !== undefined) {
      const sessionId =
        launched.resume === 'latest'
          ? (await host.listSessions(settings.profileId, settings.providerId, settings.cwd, 1))[0]?.id
          : (launched.resume as SessionId);
      if (sessionId === undefined) {
        io.stderr('No stored conversation to continue in this directory.\n');
        return 1;
      }
      conversation.loadHistory(sessionId, []);
    }

    const outcome = await conversation.send(prompt);
    if (!outcome.ok) {
      io.stderr(`${outcome.reason}\n`);
      return 1;
    }
    return await end;
  } finally {
    writer.finish();
    conversation.dispose();
  }
}
