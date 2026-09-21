/**
 * Running a turn for an HTTP caller.
 * ============================================================================
 *
 * `POST /v1/chat/completions` is the endpoint that actually does something. A
 * client sends a conversation, Artemis starts an agent run under one of the
 * user's accounts, and the reply comes back in the shape every OpenAI client
 * already understands — either whole, or streamed.
 *
 * This module is that translation and nothing else. It does not own the port
 * (see `http.ts`), it does not know what a profile is (see the {@link RunSource}
 * seam), and it does not choose the directory (see `workspaces.ts`).
 *
 * ---------------------------------------------------------------------------
 * A TURN IS NOT A COMPLETION, AND THREE THINGS FOLLOW
 * ---------------------------------------------------------------------------
 *
 * **1. Nobody is watching, so nobody can answer a permission prompt.** An
 * agentic run can stop and ask. In the app a person answers; over HTTP there is
 * usually no person, and a request that parked on a prompt would hang until the
 * client timed out with no explanation. So every permission request is **denied
 * automatically**, with a message the model can act on, and the denial is
 * reported on the response. Denying is the only safe default: the alternative
 * is a program the user has not looked at approving file writes on their behalf.
 *
 * **2. The agent's tools are its own.** A run reads files and executes commands
 * internally; those are reported as {@link ArtemisActivity}, never as OpenAI
 * `tool_calls`, because a `tool_calls` reply is a request *to the client* and no
 * client can execute Claude Code's `Bash`. See `openai.ts` in protocol.
 *
 * **3. The client can vanish.** A browser tab closes, a script is `^C`'d. The
 * run keeps going — it is a real process doing real work on the user's disk —
 * unless someone stops it, so a disconnect interrupts it. Anything else spends
 * the user's plan on output nobody will ever read.
 *
 * ---------------------------------------------------------------------------
 * …UNLESS THE CALLER SAYS IT IS A PERSON
 * ---------------------------------------------------------------------------
 *
 * Points 1 and 3 are both statements about *the client*, and both are wrong for
 * exactly one kind of client: a remote Artemis with a human in front of it. So
 * each is an opt-in the caller declares on the request, and neither is ever
 * inferred — see `ArtemisRemoteOptions` in protocol for why a socket cannot
 * tell a phone from a CI job.
 *
 *  - `artemis.remote.permissions` emits the request to the client instead of
 *    denying it, and lets the run park. Answering happens out of band, on
 *    `POST /api/v0/runs/{runId}/permission`, because the answer routinely
 *    arrives on a different connection from the one that asked — the stream
 *    this turn is writing to may already be dead.
 *  - `artemis.remote.detach` makes a disconnect leave the run alone. This
 *    module's part is small and precise: it stops interrupting on teardown and
 *    reports the detach to whoever is keeping the deadline. It does *not* take
 *    ownership of the run's eventual death, because a generator nobody is
 *    pulling from cannot enforce a timeout — see `runs.ts`. The other half of
 *    the promise is {@link resumeTurn}: a detached run's client comes back on
 *    `GET /api/v0/runs/{id}/stream?after=N` and is replayed everything after
 *    the last chunk it rendered, then follows the run live — which is what
 *    makes detaching a feature rather than a slower way to lose the answer.
 *
 * A request that sets neither is served byte for byte as it was before either
 * existed, which is the property the whole design is arranged around.
 *
 * None of this is the *remote bridge* (`remote.ts`), which serves a window
 * rather than a provider adapter, makes both promises unconditionally, and
 * keeps its own run registry with its own grace period. The two surfaces share
 * an engine and share no bookkeeping.
 */

import type {
  AgentEvent,
  ArtemisActivity,
  ArtemisChatExtensions,
  ArtemisContextReading,
  ArtemisPermissionNotice,
  Attachment,
  OpenAiChatChunk,
  OpenAiChatMessage,
  OpenAiChatRequest,
  OpenAiChatResponse,
  OpenAiFinishReason,
  BackgroundTask,
  OpenAiUsage,
  PermissionDecision,
  RunEndReason,
  RunHandle,
  RunId,
  RunInput,
  ServerModel,
  SessionDelegatedWork,
  TokenUsage,
} from '@rx-artemis/protocol';
import { hoistSlashCommand, isImageMediaType, readAttachments } from '@rx-artemis/protocol';
import type { RouteRedirect } from './sessionHome.js';

/* -------------------------------------------------------------------------- */
/* The seam                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The standing answer to a prompt nobody is present for.
 *
 * Exported because it is given in two places that must not drift: here, the
 * instant a request arrives on a turn that did not ask for prompts, and in
 * `runs.ts`, when a turn that *did* ask has waited past its deadline. Both are
 * the same sentence to the model — "there is no one here" — and a model that
 * learned to route around one wording and met another would have to learn
 * twice.
 *
 * Written for the model rather than for a log: it names the constraint and
 * offers two ways forward, so the agent treats it as a closed door rather than
 * as a fault it should retry.
 */
export const UNATTENDED_PERMISSION_MESSAGE =
  'This turn is running through the Artemis HTTP server, where no one is present to approve tool use. Continue without this action, or explain what you would need.';

/** What one turn needs from the engine. */
export interface RunSource {
  /**
   * Start a run and resolve once it is registered.
   *
   * The shape is deliberately narrower than `RunInput`: this module may not
   * choose the *tools*, because those are the user's settings and an HTTP
   * caller is not the user. Two fields have since joined it, on the same
   * reasoning each time — a thing the caller already owns is a thing the shape
   * may as well carry. The permission mode came with remote permission
   * answering: a caller trusted to approve every prompt already holds
   * everything a mode grants. The system prompt is the caller's *own* standing
   * instructions, composed on its machine and applied only as an append on top
   * of the serving provider's preset — never a replacement, which the adapter
   * refuses before the wire. Both are requests: a host honours each insofar as
   * the serving provider supports it, and an older client sends neither.
   */
  startRun(input: {
    readonly providerId: string;
    readonly profileId: string;
    readonly cwd: string;
    readonly prompt: string;
    readonly model: string;
    readonly effort?: string;
    readonly fastMode?: boolean;
    readonly ultracode?: boolean;
    readonly resumeSessionId?: string;
    /**
     * Branch from `resumeSessionId` into a new session, leaving the original
     * whole; and truncate the resumed conversation at a stored message before
     * continuing. Both are the caller's own conversation being reshaped, so
     * they belong to the caller exactly as the session id does; the serving
     * provider's own capability flags say whether it can honour them.
     */
    readonly forkSession?: boolean;
    readonly rewindToMessageId?: string;
    readonly permissionMode?: string;
    /** Standing instructions to append to the provider's preset. Append-only. */
    readonly systemPrompt?: string;
    /**
     * The caller's always-on skills, by name. The host reads each one it
     * carries off its own disk and appends the bodies after
     * {@link systemPrompt}; a name it does not carry is skipped. Names only
     * ever reach a lookup among the folders the host found, never a path.
     */
    readonly alwaysOnSkills?: readonly string[];
    /**
     * Files and images the prompt is about.
     *
     * The third field to join this shape, and on firmer ground than the other
     * two: an attachment is not a *setting* a caller might not be entitled to,
     * it is part of the message. Refusing to carry it would not narrow what an
     * HTTP caller may choose, it would silently change what they asked.
     *
     * Already read and bounded by the route — see `readAttachments` — so a host
     * hands these straight to the registry, which refuses them once more
     * against the serving provider's own `imageInput` and `fileInput`.
     */
    readonly attachments?: readonly Attachment[];
  }): Promise<RunHandle>;

  /** Every event from every run. Filtered by `runId` here. */
  subscribe(listener: (event: AgentEvent) => void): () => void;

  /** Stop a run that is still going. Called when the client disconnects. */
  interrupt(runId: RunId): Promise<void>;

  /**
   * Answer a permission request.
   *
   * The parameter is the full {@link PermissionDecision}, and the widening is
   * phase 2 of ADR 0004: a *person on another machine* answers prompts
   * through the remote routes, and remote permission answering is the heart
   * of controlling what a machine is working on. The completions surface is
   * unchanged in behaviour — `runTurn` still sends `deny`, always, because on
   * that surface nobody is watching (see the file comment) — the type simply
   * stopped pretending the seam could carry nothing else.
   */
  respondToPermission(
    runId: RunId,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void>;

  /** Release the run's resources once its reply has been written. */
  disposeRun(runId: RunId): Promise<void>;

  /* ------------------------------------------------------------------------
   * The remote bridge's observation and control surface (ADR 0004).
   *
   * Optional as a set: a host that provides none of them serves completions
   * exactly as before and the remote routes answer 501, which is what a
   * catalogue-only or pre-remote build honestly is. They are on this seam
   * rather than a second one because they are the same narrowing discipline
   * over the same engine — the server may ask exactly these questions, and a
   * route cannot reach anything the host did not choose to expose here.
   * ---------------------------------------------------------------------- */

  /** Live runs, as `runs:list` reports them to a window. */
  listRuns?(query: { readonly cwd?: string }): Promise<readonly RunHandle[]>;

  /** One run's handle — live or recently finished — for the visibility gate. */
  getRun?(runId: RunId): Promise<RunHandle | undefined>;

  /**
   * A run's retained events, exactly as `runs:events` replays them, with the
   * same `truncated` honesty flag.
   */
  runEvents?(query: { readonly runId: RunId; readonly afterSeq?: number }): Promise<{
    readonly events: readonly AgentEvent[];
    readonly truncated: boolean;
  }>;

  /**
   * Conversations still holding background work, as `runs:live-work` answers.
   * Absent when the host keeps no such ledger; the route reports empty sets,
   * which the response contract already defines as "nothing known", never
   * "nothing running".
   */
  liveWork?(): Promise<{
    readonly sessionIds: readonly string[];
    readonly working: readonly string[];
    readonly delegated: readonly SessionDelegatedWork[];
  }>;

  /**
   * Start a run with the *user's own settings* — the whole {@link RunInput}.
   *
   * Deliberately a second entry point beside the narrow {@link startRun},
   * because the two callers are different principals. A completions caller is
   * a program borrowing an account and may not choose a permission mode or a
   * tool set; the holder of a remote-bridge token is the user on another
   * machine, and refusing them their own settings would make the remote
   * window a lesser Artemis. The routes still enforce the token's scope —
   * profile allowance, model allowance, the workspace pin — before this is
   * called.
   */
  startUserRun?(input: RunInput): Promise<RunHandle>;

  /** Send another message into a live run, as `runs:send` does. */
  send?(
    runId: RunId,
    text: string,
    attachments?: readonly Attachment[],
  ): Promise<{ readonly deliveredImmediately: boolean }>;

  /** Interrupt, with the `stillQueued` detail a window renders. */
  interruptRun?(runId: RunId): Promise<{ readonly stillQueued?: readonly string[] }>;

  /** Stop one delegated task, leaving the run alone. */
  stopTask?(runId: RunId, taskId: string): Promise<void>;
}

/** Everything one turn needs, resolved by the caller before this is entered. */
export interface TurnRequest {
  readonly model: ServerModel;
  readonly cwd: string;
  readonly request: OpenAiChatRequest;
  readonly extensions: ArtemisChatExtensions;
  /** Parameters accepted but not applied, echoed back so a caller can see them. */
  readonly ignored: readonly string[];
  /**
   * The slash commands the serving account would offer.
   *
   * Only ever used to lift one to the front of the prompt when the caller put
   * it elsewhere — see {@link promptFromMessages}. Absent on a build that
   * cannot enumerate commands, which simply leaves the prompt as it was sent.
   */
  readonly slashCommands?: readonly string[];
  /**
   * The run is on a different account from the one the route named, because
   * that account is the one holding the conversation being resumed. Echoed
   * back beside {@link ignored}, for the same reason. See `sessionHome.ts`.
   */
  readonly redirected?: RouteRedirect;
  /** Aborts when the client hangs up. */
  readonly signal?: { readonly aborted: boolean; addEventListener?: unknown };
  /**
   * Told when a client walked away from a run it asked to keep.
   *
   * The one thing this module cannot do for itself. Detaching is a *transfer*:
   * from here, where the run's lifetime is bounded by a generator somebody is
   * pulling from, to something that outlives the request and can still enforce
   * a deadline. Handing over is the whole of the handover — nothing is called
   * back, and the run is no longer this turn's to end.
   *
   * Only ever called when the caller set `artemis.remote.detach`, and only for
   * a run that was still going. A turn that finished normally is disposed here
   * as it always was.
   */
  readonly onDetach?: (runId: RunId) => void;
}

/* -------------------------------------------------------------------------- */
/* Reading the request                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Flatten OpenAI's `messages` into the one prompt a turn takes.
 *
 * The rule, and it is a real semantic choice rather than a simplification:
 * **the trailing user message is the turn.** Everything before it is either
 * already in the session (when the caller passed a `sessionId`) or is context
 * the caller is re-sending because OpenAI's API is stateless and theirs has to
 * be too.
 *
 * So earlier `user` and `assistant` messages are folded into a transcript
 * *prefix* only when there is no session to resume — otherwise the agent would
 * be handed its own history a second time and would answer as though the
 * conversation had happened twice.
 *
 * `system` and `developer` messages always survive, at the front: they are
 * instructions rather than history, and a caller that sets one on every request
 * means it every time.
 *
 * `commands` is the slash commands the serving account would offer, and it is
 * what lets a caller put one somewhere other than the front of their message —
 * see {@link hoistSlashCommand}. It is applied only when the trailing user
 * message is the *whole* prompt: with a system or history prefix in front of
 * it, a lifted command would land after text the provider reads first, so it
 * would still not run, and all the lift would have achieved is a hole in
 * somebody's system prompt.
 */
export function promptFromMessages(
  messages: readonly OpenAiChatMessage[],
  options: { readonly resuming: boolean; readonly commands?: readonly string[] },
): string {
  const systems: string[] = [];
  const history: string[] = [];
  let trailing = '';

  messages.forEach((message, index) => {
    // Only the trailing user message's images are carried, so only its parts
    // are read with that in mind. See {@link attachmentsFromMessages}.
    const carried = index === messages.length - 1 && message.role === 'user';
    const text = flattenContent(message.content, carried);
    if (text.length === 0) return;

    if (message.role === 'system' || message.role === 'developer') {
      systems.push(text);
      return;
    }

    const isLast = index === messages.length - 1;
    if (isLast && message.role === 'user') {
      trailing = text;
      return;
    }

    // A `tool` message is a result the *client* produced for a tool call the
    // agent never made — Artemis's agents run their own. Carried as context
    // rather than dropped, because a caller that sent one meant something by it.
    history.push(`${message.role}: ${text}`);
  });

  const parts: string[] = [];
  if (systems.length > 0) parts.push(systems.join('\n\n'));
  if (!options.resuming && history.length > 0) {
    parts.push(`Earlier in this conversation:\n${history.join('\n')}`);
  }
  // The turn itself last, so it is the freshest thing the model reads. When a
  // caller sent only non-user messages this is empty and the history stands in.
  if (trailing.length > 0) parts.push(trailing);
  else if (options.resuming && history.length > 0) parts.push(history.join('\n'));

  const assembled = parts.join('\n\n').trim();
  // The one shape where the lift can do anything: the turn standing alone. See
  // the note above.
  return parts.length === 1 && trailing.length > 0
    ? hoistSlashCommand(assembled, options.commands)
    : assembled;
}

/**
 * OpenAI allows a string or an array of parts; both have to be read.
 *
 * `carried` says whether this message's images are the ones
 * {@link attachmentsFromMessages} is turning into attachments — true for the
 * trailing user message, which is the turn. An image that *is* being carried
 * leaves nothing behind in the text: the model is about to be shown it. One
 * that is not says so, because an image named nowhere is an image the reader
 * of the answer will never know was missing.
 */
function flattenContent(content: OpenAiChatMessage['content'], carried: boolean): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (!carried) {
        // History. Carrying these would show the model a picture from three
        // turns ago as though it were part of the question being asked now.
        return '[image omitted: only the newest message carries images]';
      }
      return imageFromPart(part, 0) === undefined
        ? // A link, or a format no provider reads as an image. Nothing here
          // fetches a URL on a caller's behalf — that is a request this server
          // would be making to an address the caller chose.
          '[image omitted: inline it as a base64 `data:` URL; a link is not fetched]'
        : '';
    })
    .filter((text) => text.length > 0)
    .join('\n')
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Images the OpenAI way                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `data:image/png;base64,iVBOR…` → an image attachment, or nothing.
 *
 * Nothing for a link (`https://…`), for a `data:` URL that is not base64, and
 * for a media type no provider reads as an image — each of which is a part this
 * server will not carry rather than a request it will fail, because an OpenAI
 * client that sent one has done nothing wrong by its own API's rules. The text
 * says what happened; see {@link flattenContent}.
 *
 * The payload itself is *not* checked here. `readAttachments` does that, once,
 * over the whole list — so a `data:` URL that parses but holds forty megabytes
 * of something that is not base64 is refused with the same message, naming the
 * same field, as one that arrived on `artemis.attachments`.
 */
function imageFromPart(
  part: { readonly type: 'image_url'; readonly image_url: { readonly url: string } },
  index: number,
): Attachment | undefined {
  const url = part.image_url?.url;
  if (typeof url !== 'string') return undefined;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match === null) return undefined;
  const [, mediaType, data] = match;
  if (!isImageMediaType(mediaType) || data === undefined || data.length === 0) return undefined;
  return {
    kind: 'image',
    // Minted here because OpenAI's shape has nowhere to put one. Positional, so
    // two parts on one message cannot collide and trip the duplicate-id check.
    id: `image-url-${String(index)}`,
    mediaType,
    data,
  };
}

/**
 * The images an OpenAI-shaped request carries, as attachments.
 *
 * Only the trailing user message's, and only when it is a user message: the
 * rule the whole request is read by is that **that message is the turn**, and
 * everything before it is history the caller is re-sending because their API is
 * stateless. Carrying history's images would show the model a picture from
 * three turns ago as though it were part of the question being asked now, and
 * would do it again on every subsequent request.
 *
 * @throws {AttachmentError} for a `data:` URL this will not accept.
 */
export function attachmentsFromMessages(
  messages: readonly OpenAiChatMessage[],
): readonly Attachment[] | undefined {
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== 'user' || !Array.isArray(last.content)) {
    return undefined;
  }

  const images: Attachment[] = [];
  last.content.forEach((part, index) => {
    if (part.type !== 'image_url') return;
    const image = imageFromPart(part, index);
    if (image !== undefined) images.push(image);
  });

  // Through the same reader as everything else, so the ceilings, the base64
  // alphabet check and the per-kind arithmetic are the ones stated in protocol
  // rather than a second opinion written here.
  return readAttachments(images, 'messages[].content[].image_url');
}

/* -------------------------------------------------------------------------- */
/* Running                                                                    */
/* -------------------------------------------------------------------------- */

/** What a finished turn produced. */
export interface TurnResult {
  readonly text: string;
  /**
   * The agent's reasoning, joined, when the provider reported any.
   *
   * Kept apart from {@link text} for the reason the file comment on
   * `openai.ts` gives: a caller reading the answer must never be handed the
   * model's working-out as though it were the reply. Absent, not empty, when
   * there was none — a field that is present says the model reasoned.
   */
  readonly thinking?: string;
  readonly finishReason: OpenAiFinishReason;
  readonly endReason: RunEndReason;
  readonly sessionId?: string;
  readonly usage?: OpenAiUsage;
  /**
   * How full the conversation is, as of the last thing the run said about it.
   *
   * Separate from {@link usage} because it is a different measurement — see
   * {@link ArtemisContextReading} — and repeated here rather than left to the
   * chunks alone because the whole-response path has no chunks, and because a
   * client that reconnects mid-turn needs the last chunk to be self-sufficient.
   */
  readonly context?: ArtemisContextReading;
  readonly activity: readonly ArtemisActivity[];
  /** Set when the run failed; the caller turns this into a 502. */
  readonly error?: string;
}

/** One streamed piece of a turn, before its cursor is stamped on. See {@link TurnEvent}. */
type TurnEventBody =
  | { readonly kind: 'text'; readonly text: string }
  | {
      /**
       * A fragment of the agent's reasoning, as it thinks.
       *
       * Its own kind rather than a flag on `text`, because the two must never
       * be confused downstream: `text` becomes `content`, which is the answer,
       * and this becomes `reasoning_content`, which is not. Only the agent's
       * own — a subagent's reasoning is that subagent's business, reported to
       * the caller as the activity that spawned it.
       */
      readonly kind: 'thinking';
      readonly text: string;
    }
  | {
      /**
       * One of the agent's own tool calls, the moment it starts and again
       * the moment it ends: its entry in the activity report as it stands
       * then, with `ok` once there is an outcome.
       *
       * Only the agent's own. A subagent's calls are the subagent's business,
       * reported to the caller through the call that spawned it — the rule a
       * subagent's text follows — so they go into the report and nowhere else.
       */
      readonly kind: 'activity';
      readonly activity: ArtemisActivity;
    }
  | {
      /**
       * The run this turn became, announced as soon as it has an id.
       *
       * First of everything, and unconditional — a caller that never uses the
       * run surface pays one field on one chunk, and a caller that does has no
       * other way to learn the address. `/v1/chat/completions` is the only
       * route that mints a run for a completions caller, and until this existed
       * the id it minted was knowable to nobody: such a client could watch a
       * run it had started only by staying attached to it, which is precisely
       * the thing that fails.
       *
       * Announced before the session id on purpose. The two arrive together for
       * a fresh conversation, and of the pair this is the one that is useful
       * immediately — interrupting, steering and approving all address the run,
       * while the session id only matters once the turn is over.
       */
      readonly kind: 'run';
      readonly runId: RunId;
      /**
       * How many stored messages the conversation held when the run began,
       * when the registry measured it. Rides the announcement so the client
       * that started the run — which could not take the count itself, the
       * conversation being on this side — can rebuild the conversation above
       * the turn after a reload. See `RunHandle.historyOffset`.
       */
      readonly historyOffset?: number;
    }
  | {
      /**
       * A permission prompt the run is parked on, or the news that it is not.
       *
       * Only for a turn that set `artemis.remote.permissions`; every other turn
       * is denied on the spot and there is nothing to report. Both states are
       * emitted, and the second is not a nicety: the request may be answered by
       * a *different* client from the one watching this stream, or by the park
       * deadline, and a watcher that only ever saw the question would hold an
       * open card over a decision that was made minutes ago.
       */
      readonly kind: 'permission';
      readonly notice: ArtemisPermissionNotice;
    }
  | {
      /**
       * The session this turn is writing to, announced as soon as it is known
       * rather than only on `done`.
       *
       * Exists for the client that wants to resume a conversation the moment it
       * can — an Artemis driving another Artemis emits its own
       * `session.started` from this — and for the caller whose stream dies
       * mid-turn, who would otherwise learn the id never. Emitted at most once
       * per id: a resumed turn's caller already holds it, so nothing is
       * announced unless the provider reports a different one.
       */
      readonly kind: 'session';
      readonly sessionId: string;
    }
  | {
      /**
       * Part of what a resumed client asked for is gone.
       *
       * The server retains a bounded tail of a run's events. A client whose
       * cursor is older than the tail's head is sent what remains, and this,
       * first, so it can say that something between the two is missing rather
       * than splice the halves together as though nothing were.
       */
      readonly kind: 'gap';
      readonly afterSeq: number;
      readonly firstSeq: number;
    }
  | {
      /**
       * The run's delegated work — the whole live set, as `background.tasks`
       * carries it. Relayed rather than dropped because it is the only word a
       * remote client has that a served conversation is still working after
       * its turn ended: without it, a subagent twenty minutes into its task
       * looked, from the laptop, like a conversation that had finished.
       */
      readonly kind: 'tasks';
      readonly tasks: readonly BackgroundTask[];
    }
  | {
      /**
       * How full the conversation is, whenever the run restates it.
       *
       * Its own kind rather than a field on the terminal result, because the
       * moment a person wants this number is while the turn is running and the
       * window is filling — a reading that only arrives once the turn is over
       * is a fuel gauge that reports at the end of the journey. It rides an
       * empty-delta chunk for the same reason `tasks` does: an OpenAI client
       * appends nothing and is unharmed, and there is no field in OpenAI's
       * shape that could carry it honestly (`usage` is a bill, not an
       * occupancy).
       *
       * Emitted only when the reading actually moved, so a provider that
       * restates the same numbers on every assistant message does not put a
       * chunk on the wire for each one.
       */
      readonly kind: 'context';
      readonly reading: ArtemisContextReading;
    }
  | {
      /**
       * The provider read a message that was steered into the run. The id is
       * the server's own filing of it; the client that sent it matches in
       * order.
       */
      readonly kind: 'delivered';
      readonly messageId: string;
    }
  | {
      /**
       * A run event that put nothing on the wire — a subagent's tool call, a
       * bill, a plan reading — passing by. Carries only its `seq`, so a
       * client's cursor keeps up with everything the server has relayed
       * rather than with the last thing it had words for: a resume then asks
       * for exactly what was missed, and a client that measures its stream
       * against the run's position on the server can tell "quiet because the
       * agent is inside a tool" from "quiet because the stream has lost its
       * place".
       */
      readonly kind: 'cursor';
    }
  | { readonly kind: 'done'; readonly result: TurnResult };

/**
 * One streamed piece of a turn.
 *
 * `seq` is the sequence number of the run event this piece was translated
 * from, and it is the resume cursor: a client that loses its stream remembers
 * the last one it rendered and asks {@link resumeTurn} for everything after
 * it. Absent on the pieces that come from nowhere in the event stream — the
 * run announcement, a session id learned from the run handle — which a client
 * can receive twice without harm.
 */
export type TurnEvent = TurnEventBody & { readonly seq?: number };

/* -------------------------------------------------------------------------- */
/* Translating a run's events                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One run's events, read into the reply's vocabulary.
 *
 * This translation used to live inline in {@link runTurn}, and it moved into
 * a class the day a second reader appeared: {@link resumeTurn} replays a run's
 * retained events for a client that lost its stream, and "what a text delta
 * becomes on the wire" has to have exactly one answer, or the client that
 * stayed and the client that came back would be shown two different turns.
 * Everything stateful about the translation lives here — the text seen so
 * far, the reasoning block in progress, which session id has been announced,
 * the activity report — and the two generators own the I/O around it.
 *
 * One event may become several {@link TurnEvent}s or none. Each carries the
 * `seq` of the event it came from, which is what a resume cursor points at.
 * The translation performs no I/O: the one thing it cannot do for itself, the
 * standing denial of a permission prompt on an unattended turn, it hands back
 * as `deny` for the caller to send.
 */
/**
 * The block a text event belongs to.
 *
 * `blockIndex` is optional on a completed block and absent on the events some
 * adapters emit, so an absent index is spelled out rather than left to
 * `String(undefined)` — two blocks that both lack one are the *same* key, which
 * is the conservative reading: a delta and a completion with no index at all
 * are one block, exactly as they were before blocks were told apart.
 */
function blockKey(messageId: string, blockIndex: number | undefined): string {
  return `${messageId}:${blockIndex === undefined ? '-' : String(blockIndex)}`;
}

class TurnTranslator {
  text = '';
  thinking = '';
  /**
   * The text blocks whose deltas already crossed, by block.
   *
   * What lets a completed block be told apart from a streamed one *per block*
   * rather than per turn. The check used to be "has any text been sent yet",
   * which took the first block of a turn and dropped every later one that
   * arrived whole — and the block that arrives whole is routinely the last:
   * the agent's own summary after its tool calls, the one message a person
   * reads. Seen on a served session on 2026-09-15: every word of reasoning
   * came through, the opening sentence came through, and the bolded summary
   * at the end never did, while the transcript on the server had it.
   */
  readonly #streamedBlocks = new Set<string>();
  /** The text block the last fragment belonged to, for the break between two. */
  #textBlock: string | undefined;
  /** The reasoning block being relayed, so a new one is set off from the last. */
  #thinkingBlock: string | undefined;
  /*
   * Seeded from the request when resuming a session, and that is a fix rather
   * than a convenience.
   *
   * A *new* session announces itself with `session.started`, so the id is
   * observed. A *resumed* one does not — the session already started, on an
   * earlier turn — and providers do not always repeat it on `run.end` either.
   * The response therefore came back with no `sessionId` from the second turn
   * onward, so a client following the documented pattern (send back what you
   * were given) lost the thread after exactly one exchange. Caught by holding
   * a real two-turn conversation with a Codex account.
   *
   * Echoing the id we were handed is honest: this turn did run in that
   * session, which is precisely what the field means. Anything the run reports
   * later overwrites it.
   */
  sessionId: string | undefined;
  /**
   * The id the caller has already been told, so a fresh session is announced
   * exactly once and a resumed one — whose caller sent the id in — not at all.
   * See the `session` member of {@link TurnEventBody}.
   */
  #announced: string | undefined;
  usage: OpenAiUsage | undefined;
  /**
   * The context reading, accumulated rather than replaced.
   *
   * Its two halves arrive on different events and neither restates the other.
   * Claude reports occupancy on every assistant message (`delta` scope, no
   * window) and the window size once, on the result (`final` scope, no
   * occupancy); Codex repeats the window on each update and the local adapter
   * probes it once over HTTP. Taking the latest snapshot wholesale would
   * therefore leave the reading with only ever one of the two numbers — which
   * is exactly a gauge with a needle and no dial, or a dial and no needle.
   */
  context: { tokens?: number; window?: number } = {};
  deniedPermission = false;
  readonly activity: ArtemisActivity[] = [];
  /**
   * The calls whose start went out live, by id.
   *
   * An end goes out live exactly when its start did. Deciding that again from
   * the `tool.end` alone would trust every adapter to stamp the same `agentId`
   * on both halves of a call; one that did not would send a subagent's ending
   * as a row of the agent's own, or leave a row the caller is drawing running
   * until the turn is over.
   */
  readonly #liveCalls = new Set<string>();
  /** Set by the `run.end` this saw. The turn is over from then on. */
  result: TurnResult | undefined;
  readonly #remotePermissions: boolean;

  /**
   * Fold one usage snapshot's context half into {@link context}.
   *
   * Returns the merged reading when it moved, and `undefined` when it did not,
   * so the caller can decide whether the wire needs a chunk. A snapshot with
   * neither half — every provider that reports a bill and no occupancy — moves
   * nothing and produces nothing, which is how a route that cannot answer this
   * question stays silent rather than sending empty readings.
   */
  #readContext(usage: {
    readonly contextTokens?: number;
    readonly contextWindow?: number;
  }): ArtemisContextReading | undefined {
    const tokens = usage.contextTokens ?? this.context.tokens;
    const window = usage.contextWindow ?? this.context.window;
    if (tokens === this.context.tokens && window === this.context.window) return undefined;
    this.context = {
      ...(tokens === undefined ? {} : { tokens }),
      ...(window === undefined ? {} : { window }),
    };
    return { ...this.context };
  }

  constructor(options: { readonly remotePermissions: boolean; readonly sessionId?: string }) {
    this.#remotePermissions = options.remotePermissions;
    this.sessionId = options.sessionId;
    this.#announced = options.sessionId;
  }

  /** Announce a session id learned outside the event stream — the run handle's. */
  /**
   * Put a fragment of answer on the wire, and into the whole reply.
   *
   * Two blocks of answer — one before a tool call and one after, say — are
   * two paragraphs, and on a flat stream the only way to keep the last word
   * of one off the first word of the next is a paragraph break between them:
   * the rule the reasoning field already follows. A client that draws each
   * block as its own row drops the break at the head of a fresh row.
   */
  #appendText(key: string, text: string, out: TurnEvent[], seq: number, streamed: boolean): void {
    if (text === '') return;
    const fragment =
      this.#textBlock !== undefined && this.#textBlock !== key && this.text.length > 0
        ? `\n\n${text}`
        : text;
    this.#textBlock = key;
    if (streamed) this.#streamedBlocks.add(key);
    this.text += fragment;
    out.push({ kind: 'text', text: fragment, seq });
  }

  announce(sessionId: string | undefined): readonly TurnEvent[] {
    if (sessionId !== undefined) this.sessionId = sessionId;
    if (this.sessionId === undefined || this.sessionId === this.#announced) return [];
    this.#announced = this.sessionId;
    return [{ kind: 'session', sessionId: this.sessionId }];
  }

  /**
   * Read one event.
   *
   * `deny` names a permission request the caller must answer with the
   * standing denial: only ever on a turn whose caller did not ask to be shown
   * prompts, and only ever the caller's to send.
   */
  translate(event: AgentEvent): { readonly events: readonly TurnEvent[]; readonly deny?: string } {
    const out: TurnEvent[] = [];
    const seq = event.seq;

    switch (event.type) {
      case 'session.started':
        this.sessionId = String(event.sessionId);
        if (this.sessionId !== this.#announced) {
          this.#announced = this.sessionId;
          out.push({ kind: 'session', sessionId: this.sessionId, seq });
        }
        break;

      case 'text.delta':
        /*
         * The agent's own words only.
         *
         * A subagent's text arrives on the same feed, marked with the id of
         * the call that spawned it, and it is not the answer: it is a report
         * to the agent, which reads it and then says what it has to say. The
         * caller sees the call itself in the activity report. Relaying the
         * words as well handed a caller every subagent's findings inline
         * *and then* the agent's account of them — the same answer twice, in
         * two voices.
         */
        if (event.agentId !== undefined) break;
        this.#appendText(blockKey(event.messageId, event.blockIndex), event.text, out, seq, true);
        break;

      case 'text.complete':
        /*
         * Only when nothing streamed.
         *
         * Providers that stream emit deltas *and* a completing block with the
         * whole text; appending both would double every reply. `partialMessages`
         * says which a provider does, but the honest check is whether anything
         * actually arrived — an adapter that claims streaming and sends none
         * would otherwise produce an empty answer.
         *
         * Never a replayed block: a resumed conversation reads its history
         * back through the same event, and a previous turn's answer is not
         * this turn's. Same rule for a subagent's block as for its deltas.
         */
        if (event.agentId !== undefined || event.replay === true) break;
        if (event.role !== 'assistant') break;
        // This block's own deltas already carried it; the whole text now would
        // be the same answer twice. Any *other* block that arrives whole is new
        // — see `#streamedBlocks` for the turn-wide check this replaces.
        if (this.#streamedBlocks.has(blockKey(event.messageId, event.blockIndex))) break;
        this.#appendText(blockKey(event.messageId, event.blockIndex), event.text, out, seq, false);
        break;

      case 'thinking.delta': {
        /*
         * Forwarded on its own channel, never into `text`.
         *
         * A redacted block has nothing to show — the provider kept the
         * reasoning and sent a signature — and an empty fragment is not a
         * delivery, so neither crosses the wire. The subagent rule is the
         * one `text.delta` gives.
         *
         * The wire has no blocks, only fragments, so the boundary between
         * two reasoning blocks — one either side of a tool call, typically —
         * travels as a paragraph break. Without it the last word of one and
         * the first of the next arrive glued together, on the stream and in
         * the whole reply alike.
         */
        if (event.agentId !== undefined || event.redacted === true || event.text === '') break;
        const block = `${event.messageId}:${String(event.blockIndex)}`;
        const fragment =
          this.#thinkingBlock === undefined || this.#thinkingBlock === block
            ? event.text
            : `\n\n${event.text}`;
        this.#thinkingBlock = block;
        this.thinking += fragment;
        out.push({ kind: 'thinking', text: fragment, seq });
        break;
      }

      case 'tool.start': {
        const id = String(event.toolCallId);
        const summary = summariseToolInput(event.input);
        const entry: ArtemisActivity = {
          id,
          tool: event.name.toLowerCase(),
          at: event.ts,
          ...(summary === undefined ? {} : { summary }),
        };
        // Every call goes into the report, a subagent's included: the report
        // is the account of everything the turn did.
        this.activity.push(entry);
        /*
         * Onto the wire as it starts, and only the agent's own.
         *
         * The report arrives whole on the final chunk, so on its own it put
         * nothing on screen while the agent worked: a served turn sat still
         * for minutes and then drew every call at once. A subagent's calls
         * stay out, for the reason its text does — the caller sees the call
         * that spawned it.
         */
        if (event.agentId !== undefined) break;
        this.#liveCalls.add(id);
        out.push({ kind: 'activity', activity: entry, seq });
        break;
      }

      case 'tool.end': {
        /*
         * The call's report entry, closed with its outcome, and on the wire
         * again if its start went out. `ok` is the protocol's yes or no, so a
         * denial and a cancellation both read as a call that did not succeed.
         *
         * Matched to the latest start by that id that is still running, so an
         * ending the adapter sends twice closes the call once. An ending with
         * no start this turn has seen — a resume whose retained tail begins
         * after the start — has nothing to close, and puts only its cursor on
         * the wire.
         */
        const id = String(event.toolCallId);
        const index = this.activity.findLastIndex(
          (entry) => entry.id === id && entry.ok === undefined,
        );
        const started = this.activity[index];
        if (started === undefined) break;
        const ended: ArtemisActivity = { ...started, ok: event.status === 'ok' };
        this.activity[index] = ended;
        if (this.#liveCalls.has(id)) out.push({ kind: 'activity', activity: ended, seq });
        break;
      }

      case 'permission.request':
        /*
         * Denied on the spot, unless the caller said there is somebody there.
         *
         * The default is the old one and the message is written for the
         * *model*: it explains the constraint so the agent can choose another
         * route, rather than reading as a fault.
         *
         * The opted-in path answers nothing here, and that is the design
         * rather than an omission. The decision arrives on a different
         * request — often on a different socket, minutes later, after this
         * stream has died — so parking is simply *not replying*: the adapter
         * is already blocked, and `runs.ts` holds the deadline that stops it
         * being blocked forever. All this branch owes the client is the
         * question.
         */
        if (this.#remotePermissions) {
          out.push({ kind: 'permission', notice: { status: 'requested', request: event.request }, seq });
          break;
        }
        this.deniedPermission = true;
        return { events: out, deny: String(event.requestId) };

      case 'permission.resolved':
        // Only for the client that was told about the request in the first
        // place. A turn on the standing denial saw no question, so news that
        // the question is closed would be an event about nothing.
        if (this.#remotePermissions) {
          out.push({
            kind: 'permission',
            notice: {
              status: 'resolved',
              requestId: event.requestId,
              outcome: event.outcome,
              ...(event.note === undefined ? {} : { note: event.note }),
            },
            seq,
          });
        }
        break;

      case 'usage': {
        this.usage = toOpenAiUsage(event.usage.tokens);
        const reading = this.#readContext(event.usage);
        if (reading !== undefined) out.push({ kind: 'context', reading, seq });
        break;
      }

      case 'background.tasks':
        out.push({ kind: 'tasks', tasks: event.tasks, seq });
        break;

      case 'message.delivered':
        out.push({ kind: 'delivered', messageId: String(event.messageId), seq });
        break;

      case 'run.end': {
        if (event.sessionId !== undefined) this.sessionId = String(event.sessionId);
        if (event.usage !== undefined) {
          this.usage = toOpenAiUsage(event.usage.tokens);
          // Folded in, not emitted: the `done` chunk below carries the whole
          // reading, so a separate `context` event before it would be the same
          // numbers twice.
          this.#readContext(event.usage);
        }
        // The provider's own summary, when it wrote one and nothing streamed.
        if (this.text.length === 0 && event.result !== undefined) this.text = event.result;

        this.result = {
          text: this.text,
          ...(this.thinking.length === 0 ? {} : { thinking: this.thinking }),
          finishReason: finishReasonFor(event.reason),
          endReason: event.reason,
          ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
          ...(this.usage === undefined ? {} : { usage: this.usage }),
          ...(this.context.tokens === undefined && this.context.window === undefined
            ? {}
            : { context: { ...this.context } }),
          activity: this.activity,
          ...(event.reason === 'error' ? { error: event.error?.message ?? 'The run failed.' } : {}),
          ...(this.deniedPermission && event.reason === 'permission_denied'
            ? { error: 'The agent needed permission that no one was present to give.' }
            : {}),
        };
        out.push({ kind: 'done', result: this.result, seq });
        break;
      }

      default:
        // The slash-command list, a plan reading, a command run and the rest.
        // Not silently dropped by accident — none of them has a place in an
        // OpenAI reply. (Thinking has its own case above, and its own field
        // on the wire, precisely so it is never concatenated into `content`,
        // where a caller would read a model's private reasoning as its
        // answer. Delegated work, deliveries and tool calls have theirs too,
        // for the reasons on their `TurnEventBody` members.)
        break;
    }

    return { events: out };
  }
}

/**
 * A queue between the engine's callback and a `for await`.
 *
 * The subscription is attached *before* the run is started or replayed — a
 * fast provider can emit `session.started` and text before a promise settles,
 * and a listener attached afterwards would miss the opening of the turn.
 * `runId` is null only in the window before `startRun` resolves; events for
 * *other* runs are filtered by the caller, which is why one global
 * subscription is enough for any number of concurrent turns.
 */
function subscribeQueue(
  source: RunSource,
  accept: (event: AgentEvent) => boolean,
): {
  readonly pending: AgentEvent[];
  /** Wait for the next event, or for the slice to elapse. */
  readonly wait: () => Promise<void>;
  readonly unsubscribe: () => void;
} {
  const pending: AgentEvent[] = [];
  let notify: (() => void) | null = null;
  const unsubscribe = source.subscribe((event) => {
    if (!accept(event)) return;
    pending.push(event);
    notify?.();
  });
  const wait = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      notify = resolve;
      setTimeout(resolve, 250);
    });
    notify = null;
  };
  return { pending, wait, unsubscribe };
}

/**
 * Start a run and yield its progress until it ends.
 *
 * An async generator rather than a callback so both surfaces read the same way:
 * the streaming handler forwards each event as it arrives, the non-streaming one
 * drains to the `done`. There is exactly one implementation of the run lifecycle,
 * which is what keeps the two from diverging on when a turn is over.
 */
export async function* runTurn(
  source: RunSource,
  turn: TurnRequest,
): AsyncGenerator<TurnEvent> {
  const resuming = turn.extensions.sessionId !== undefined;
  const prompt = promptFromMessages(turn.request.messages, {
    resuming,
    ...(turn.slashCommands === undefined ? {} : { commands: turn.slashCommands }),
  });
  /*
   * Read once, and read as `=== true`, so that a caller who sent `remote: {}`,
   * or nothing at all, is on the old path by construction rather than by the
   * absence of a branch somebody might later add.
   *
   * Detaching additionally requires somewhere to hand the run *to*. Skipping
   * the interrupt without a handover would not be a weaker promise, it would be
   * a leak: a run with no client, no owner and no deadline, held by the
   * provider until the process dies. A build with nowhere to put it therefore
   * ignores the request and ends the run as it always did, which is the honest
   * degradation — the caller loses a feature rather than the server losing
   * track of a subprocess.
   */
  const detachable = turn.extensions.remote?.detach === true && turn.onDetach !== undefined;
  const remotePermissions = turn.extensions.remote?.permissions === true;

  let ended = false;
  let runId: RunId | null = null;
  const queue = subscribeQueue(source, (event) => runId === null || event.runId === runId);
  const translator = new TurnTranslator({
    remotePermissions,
    ...(turn.extensions.sessionId === undefined ? {} : { sessionId: turn.extensions.sessionId }),
  });

  try {
    let handle: RunHandle;
    try {
      handle = await source.startRun({
        providerId: turn.model.providerId,
        profileId: String(turn.model.profileId),
        cwd: turn.cwd,
        prompt,
        model: turn.model.id,
        ...(turn.extensions.thinking === undefined ? {} : { effort: turn.extensions.thinking }),
        ...(turn.extensions.fastMode === undefined ? {} : { fastMode: turn.extensions.fastMode }),
        ...(turn.extensions.ultracode === undefined
          ? {}
          : { ultracode: turn.extensions.ultracode }),
        ...(turn.extensions.sessionId === undefined
          ? {}
          : { resumeSessionId: turn.extensions.sessionId }),
        // Only meaningful beside a session id, which the route has already
        // required of them.
        ...(turn.extensions.forkSession === undefined
          ? {}
          : { forkSession: turn.extensions.forkSession }),
        ...(turn.extensions.rewindToMessageId === undefined
          ? {}
          : { rewindToMessageId: turn.extensions.rewindToMessageId }),
        ...(turn.extensions.permissionMode === undefined
          ? {}
          : { permissionMode: turn.extensions.permissionMode }),
        ...(turn.extensions.systemPrompt === undefined
          ? {}
          : { systemPrompt: turn.extensions.systemPrompt }),
        ...(turn.extensions.alwaysOnSkills === undefined
          ? {}
          : { alwaysOnSkills: turn.extensions.alwaysOnSkills }),
        // Read off `artemis.attachments` and off the trailing message's
        // `image_url` parts, merged and bounded together by the route.
        ...(turn.extensions.attachments === undefined
          ? {}
          : { attachments: turn.extensions.attachments }),
      });
    } catch (error) {
      yield {
        kind: 'done',
        result: {
          text: '',
          finishReason: 'stop',
          endReason: 'error',
          activity: [],
          error: error instanceof Error ? error.message : 'The run could not be started.',
        },
      };
      return;
    }

    runId = handle.runId;
    yield {
      kind: 'run',
      runId,
      ...(handle.historyOffset === undefined ? {} : { historyOffset: handle.historyOffset }),
    };
    yield* translator.announce(handle.sessionId === undefined ? undefined : String(handle.sessionId));

    // Events that arrived while `startRun` was in flight were queued with no
    // filter; drop any that turned out to belong to another run.
    const { pending } = queue;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index]?.runId !== runId) pending.splice(index, 1);
    }

    while (!ended) {
      if (pending.length === 0) {
        // Waiting for the next event, or for a client that has gone away.
        if (turn.signal?.aborted === true) {
          /*
           * A detachable run stops being this turn's business the moment its
           * client goes: returning hands it to `finally`, which detaches rather
           * than interrupts. Draining on would be worse than pointless — it
           * holds the request handler open writing into a dead socket for as
           * long as the agent keeps working, which for the case this feature
           * exists for is hours.
           */
          if (detachable) return;
          await source.interrupt(runId).catch(() => undefined);
          // Keep draining: the run answers the interrupt with a `run.end`, and
          // leaving without it would strand the subscription.
        }
        await queue.wait();
        continue;
      }

      const event = pending.shift();
      if (event === undefined) continue;

      const { events, deny } = translator.translate(event);
      if (deny !== undefined) {
        await source
          .respondToPermission(runId, deny, {
            behavior: 'deny',
            message: UNATTENDED_PERMISSION_MESSAGE,
          })
          .catch(() => undefined);
      }
      if (event.type === 'run.end') ended = true;
      yield* events;
      if (events.length === 0) yield { kind: 'cursor', seq: event.seq };
    }
  } finally {
    queue.unsubscribe();

    /*
     * Interrupt on *any* teardown, not just an observed abort.
     *
     * The in-loop `signal.aborted` check only runs while something is pulling
     * from this generator. When a client disconnects, the thing pulling — the
     * SSE writer — stops, and the generator is left suspended at a `yield`
     * with the run still going: the loop never gets another turn, so it never
     * notices, and the provider keeps spending the user's plan on output that
     * will never be read.
     *
     * `finally` runs whichever way the generator ends, including `.return()`
     * from a consumer that walked away, so this is the one place the guarantee
     * can actually be made. `ended` is what keeps a completed turn from being
     * pointlessly interrupted on its way out.
     *
     * Found by the abort test, which passed the in-loop check and still saw the
     * run left running.
     *
     * The exception is a run whose caller asked to keep it. There the same
     * teardown means the opposite thing — the client is gone and the work is
     * meant to survive — so the run is handed on instead of ended, and nothing
     * here disposes it: disposing would release the provider process the whole
     * feature exists to keep. A turn that *finished* is disposed either way,
     * because there is no work left to survive.
     */
    if (runId !== null) {
      if (!ended && detachable) {
        turn.onDetach?.(runId);
      } else {
        if (!ended) await source.interrupt(runId).catch(() => undefined);
        await source.disposeRun(runId).catch(() => undefined);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Picking a run back up                                                      */
/* -------------------------------------------------------------------------- */

/** What a client that lost its stream asks for. */
export interface ResumeRequest {
  readonly runId: RunId;
  /**
   * The last `seq` the client rendered. Everything after it is replayed;
   * absent means everything the server still holds, which is right for a
   * client whose stream died before it saw a single numbered piece.
   */
  readonly afterSeq?: number;
  /** Aborts when the client hangs up again. */
  readonly signal?: TurnRequest['signal'];
  /**
   * Told when the client walked away again before the run ended. The same
   * handover {@link TurnRequest.onDetach} makes, for the same reason: a run
   * that has already outlived one socket is nobody's to end on the next.
   */
  readonly onDetach?: (runId: RunId) => void;
  /**
   * The conversation the run is known to be in, when the caller already holds
   * it. Echoed on the final chunk the way a resumed turn echoes the id it was
   * handed: this turn did run in that session, and a client that joined a run
   * it never started has no other way to learn it if the replay has dropped
   * the announcement.
   */
  readonly sessionId?: string;
}

/** What a caller that wants to speak into a run already going asks for. */
export interface SteerRequest extends ResumeRequest {
  /** The message, already flattened the way {@link promptFromMessages} does. */
  readonly prompt: string;
  /**
   * Files and images this message is about.
   *
   * A steer carries them for the same reason an opening prompt does — the
   * message is about them — and the adapters already take them on `Run.send`,
   * staging them into the same directory the run's first prompt staged into,
   * numbered on from what is already there.
   */
  readonly attachments?: readonly Attachment[];
}

/**
 * Speak into a run that is already going, then follow it.
 *
 * The turn a completions caller means when it sends a message to a
 * conversation the server is still working on. Starting a second run there
 * is not an option — the provider adapters refuse it, and before they did it
 * put two CLIs on one transcript — and refusing the caller outright would
 * lose the one thing they had to say. So the message goes in as a steer, the
 * way a window's composer steers a live run, and the caller is attached to
 * the run's stream exactly as a client that lost its socket is: every event
 * the server still holds, then the live tail, until the run ends.
 *
 * The send comes first and the subscription second, and that order is safe:
 * {@link resumeTurn} replays the retained buffer after subscribing and
 * deduplicates by `seq`, so an event the steer provoked before the
 * subscription landed is still delivered, once, from the buffer.
 *
 * Replayed from the start unless the caller says otherwise. A caller steering
 * a run it never saw has missed everything that run has done — that is why
 * it thought the conversation was idle — and the catch-up is the answer to
 * the question it was really asking.
 */
export async function* steerTurn(
  source: RunSource,
  request: SteerRequest,
): AsyncGenerator<TurnEvent> {
  if (source.send === undefined) {
    throw new Error('This Artemis build cannot send into a running turn.');
  }
  await source.send(request.runId, request.prompt, request.attachments);
  const { prompt: _prompt, attachments: _attachments, ...resume } = request;
  yield* resumeTurn(source, resume);
}

/**
 * Pick a run back up from its retained events, then follow it live.
 *
 * The other half of `artemis.remote.detach`. Detaching kept the run alive when
 * its client vanished; until this existed nothing brought the client back, so
 * a laptop that slept through a turn woke to an error and a run it could only
 * read as history. Now the client asks for everything after the last piece it
 * rendered, and gets the same pieces, translated the same way, that it would
 * have received had the socket held.
 *
 * Two things this deliberately does not do:
 *
 *  - **It never denies a prompt.** A run that can be resumed is one whose
 *    caller asked for detachment, and the prompts it raised while nobody was
 *    attached are exactly what the caller is coming back for — `runs.ts`
 *    suspends their deadline for the same reason. They are put on the wire as
 *    questions, as they were the first time.
 *  - **It never interrupts or disposes.** The run's lifetime belongs to the
 *    turn that started it and to the directory's own deadline; a stream that
 *    merely watches has no business ending what it watches. When the client
 *    goes again, the run is handed back to the directory exactly as before.
 *
 * The replay is read *after* the live subscription is attached, so nothing
 * emitted between the two can be missed, and whatever arrives twice — retained
 * and queued — is deduplicated by `seq`: an event's translation is sent at most
 * once, in order. A retained buffer that has dropped its head cannot be
 * replayed from before its first event; what remains is still sent, which is
 * more than the nothing the client had.
 */
export async function* resumeTurn(
  source: RunSource,
  request: ResumeRequest,
): AsyncGenerator<TurnEvent> {
  const { runId } = request;
  const after = request.afterSeq ?? -1;
  const queue = subscribeQueue(source, (event) => event.runId === runId);
  // Nobody is denied on a resumed stream; see the function comment.
  const translator = new TurnTranslator({
    remotePermissions: true,
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
  });
  let ended = false;
  let lastSeq = -1;

  const relay = function* (event: AgentEvent): Generator<TurnEvent> {
    if (event.seq <= lastSeq) return;
    lastSeq = event.seq;
    const { events } = translator.translate(event);
    if (event.type === 'run.end') ended = true;
    if (event.seq > after) {
      yield* events;
      if (events.length === 0) yield { kind: 'cursor', seq: event.seq };
    }
  };

  try {
    const replay =
      source.runEvents === undefined
        ? { events: [] as readonly AgentEvent[], truncated: false }
        : await source.runEvents({ runId });

    // The run id first, as on the original stream: a client rebuilding from
    // nothing learns the address before anything addressed to it. The seam
    // rides with it while the registry still knows the run, so a client that
    // joins a turn in progress is told where the history it reads should end.
    const handle = source.getRun === undefined ? undefined : await source.getRun(runId);
    yield {
      kind: 'run',
      runId,
      ...(handle?.historyOffset === undefined ? {} : { historyOffset: handle.historyOffset }),
    };
    const first = replay.events[0]?.seq;
    if (first !== undefined && first > after + 1) {
      yield { kind: 'gap', afterSeq: after, firstSeq: first };
    }
    for (const event of replay.events) yield* relay(event);
    if (ended) return;

    const { pending } = queue;
    while (!ended) {
      if (pending.length === 0) {
        // The client went away again. `finally` hands the run back.
        if (request.signal?.aborted === true) return;
        await queue.wait();
        continue;
      }
      const event = pending.shift();
      if (event === undefined) continue;
      yield* relay(event);
    }
  } finally {
    queue.unsubscribe();
    if (!ended) request.onDetach?.(runId);
  }
}

/**
 * OpenAI's four finish reasons, from Artemis's seven end reasons.
 *
 * Everything that is not "ran out of room" reports `stop`, and the true reason
 * travels on `artemis.endReason`. A client switches on `finish_reason`, so a
 * value outside OpenAI's set is an unhandled branch in code we do not own —
 * whereas an extra field it does not read costs it nothing.
 */
export function finishReasonFor(reason: RunEndReason): OpenAiFinishReason {
  return reason === 'max_turns' || reason === 'budget_exceeded' ? 'length' : 'stop';
}

/**
 * Artemis's token counts in OpenAI's vocabulary.
 *
 * The two vocabularies do not line up field for field, and taking the two that
 * share a *name* is what made this wrong: Artemis's `inputTokens` is the
 * uncached remainder of the prompt, where OpenAI's `prompt_tokens` is the whole
 * of it. Every cached turn therefore reported a prompt one or two orders of
 * magnitude smaller than the one it had actually sent — confirmed live against
 * a served account, which answered `prompt_tokens: 10` for a turn whose prompt
 * ran to about twenty thousand. Nothing looked broken; it looked cheap.
 *
 * So the prompt is summed and the parts are named. See {@link OpenAiUsage} for
 * which field each part goes to and why one of them is not OpenAI's.
 */
function toOpenAiUsage(tokens: TokenUsage): OpenAiUsage {
  const cacheRead = tokens.cacheReadInputTokens;
  const cacheCreation = tokens.cacheCreationInputTokens;
  const prompt = tokens.inputTokens + (cacheRead ?? 0) + (cacheCreation ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: tokens.outputTokens,
    total_tokens: prompt + tokens.outputTokens,
    // Omitted, not zeroed, on a provider with no prompt cache: `0` claims
    // nothing was cached, and absence claims nothing at all.
    ...(cacheRead === undefined ? {} : { prompt_tokens_details: { cached_tokens: cacheRead } }),
    ...(cacheCreation === undefined ? {} : { cache_creation_input_tokens: cacheCreation }),
  };
}

/**
 * One line naming what a tool acted on — never what it found.
 *
 * A path, a command, a pattern. Deliberately not the tool's *result*: that is
 * file contents, and a caller reading activity wants to know the agent read
 * `src/index.ts`, not to receive it.
 */
function summariseToolInput(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value.slice(0, 200);
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Shaping the reply                                                          */
/* -------------------------------------------------------------------------- */

/** Build the whole-response body an OpenAI client expects. */
export function chatResponse(input: {
  readonly id: string;
  readonly model: string;
  readonly created: number;
  readonly result: TurnResult;
  readonly ignored: readonly string[];
  readonly redirected?: RouteRedirect;
  readonly resolvedModel?: string;
}): OpenAiChatResponse {
  const { result } = input;
  return {
    id: input.id,
    object: 'chat.completion',
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: result.text,
          ...(result.thinking === undefined ? {} : { reasoning_content: result.thinking }),
        },
        finish_reason: result.finishReason,
      },
    ],
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    artemis: {
      ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
      ...(input.resolvedModel === undefined ? {} : { resolvedModel: input.resolvedModel }),
      ...(input.ignored.length === 0 ? {} : { ignored: input.ignored }),
      ...(input.redirected === undefined ? {} : { redirected: input.redirected }),
      ...(result.activity.length === 0 ? {} : { activity: result.activity }),
      ...(result.context === undefined ? {} : { context: result.context }),
      endReason: result.endReason,
      // Only reached when the turn produced text *and* failed — a failure with
      // nothing to show for it never gets here, because the handler turns that
      // into a 502 whose body is this same string. Carrying it here is what
      // makes the two paths agree: a caller should not have to know whether the
      // reason arrives as a status code or as a field.
      ...(result.error === undefined ? {} : { error: result.error }),
    },
  };
}

/** One streamed chunk, in OpenAI's shape. */
export function chatChunk(input: {
  readonly id: string;
  readonly model: string;
  readonly created: number;
  readonly delta: {
    readonly role?: 'assistant';
    readonly content?: string;
    readonly reasoning_content?: string;
  };
  readonly finishReason?: OpenAiFinishReason;
  readonly usage?: OpenAiUsage;
  readonly artemis?: OpenAiChatChunk['artemis'];
}): OpenAiChatChunk {
  return {
    id: input.id,
    object: 'chat.completion.chunk',
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        delta: input.delta,
        finish_reason: input.finishReason ?? null,
      },
    ],
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.artemis === undefined ? {} : { artemis: input.artemis }),
  };
}
