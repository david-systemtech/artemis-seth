/**
 * One conversation, driven from a terminal.
 *
 * The controller between the keyboard and the `RunRegistry`. It owns the
 * transcript model, the settings a run starts with, and the one rule that
 * shapes everything else here:
 *
 * **A run is one turn.** `run.end` closes it and retires the id. The next
 * message is a *fresh* `start()` carrying `resumeSessionId`, so the provider
 * continues the same session under a new run. `send()` is different: it steers
 * the turn already in flight, and only providers with `midRunSteering` have
 * it. So there are exactly two ways a message leaves the composer —
 *
 *  - a run is live and the provider steers → `driver.send(runId, text)`
 *  - otherwise                              → `driver.start({ …, resumeSessionId })`
 *
 * — and everything the status bar says about "queued" or "wait for this turn"
 * falls out of which path was taken.
 *
 * The steers that have gone out and not been read yet are kept as a *list*, not
 * a tally. The provider folds a mid-turn message in at its next tool break, and
 * that fold is invisible from outside its process: the only thing that can
 * strike an entry is the `message.delivered` naming the one message that was
 * read, and a count cannot say *which* one it lost. Keeping the text as well
 * answers the question a person actually has — what am I waiting on? — and is
 * what makes {@link Conversation.takeBackQueued} possible at all. The desktop's
 * `PaneState.queuedSteers` made the same move, for the same reason.
 *
 * The transcript is `@rx-artemis/transcript`'s model, the same one the desktop
 * renderer draws from, fed the same `AgentEvent`s. The optimistic user row is
 * pushed before the round-trip under the identity the registry will file the
 * prompt as — `${runId}:prompt:${n}` — which is what lets a later replay merge
 * onto it rather than draw it twice; `pushUserMessage`'s own comment says why.
 *
 * The state also carries *what the agent is doing right now* — the turn's
 * start time, a one-line activity, and the tokens it has written since. That
 * reading belongs here rather than in the status bar because it is a fold over
 * the event stream, and the stream only passes through this class: the bar
 * gets a snapshot and a clock of its own. See {@link ConversationActivity}.
 *
 * Nothing here touches Ink or `process`. The driver is an interface the
 * registry satisfies structurally, so the tests hand in a fake and the
 * behaviour above is checked without spawning anything.
 */

import { randomUUID } from 'node:crypto';

import type {
  AgentEvent,
  Attachment,
  BackgroundTask,
  Capabilities,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionRequestId,
  PlanUsage,
  ProfileId,
  ProviderId,
  RunHandle,
  RunId,
  RunInput,
  SessionId,
  ThinkingDeltaEvent,
  ToolCallId,
  UsageSnapshot,
} from '@rx-artemis/protocol';
import { NO_CAPABILITIES, applyPlanLimit } from '@rx-artemis/protocol';
import {
  TranscriptModel,
  frameScheduler,
  oneLine,
  summarizeToolInput,
  type Scheduler,
} from '@rx-artemis/transcript';

/** The slice of `RunRegistry` a conversation needs. Satisfied structurally. */
export interface RunDriver {
  start(input: RunInput): Promise<RunHandle>;
  send(
    runId: RunId,
    text: string,
    attachments?: readonly Attachment[],
  ): Promise<{ readonly deliveredImmediately: boolean }>;
  interrupt(runId: RunId): Promise<unknown>;
  respondToPermission(
    runId: RunId,
    requestId: PermissionRequestId,
    decision: PermissionDecision,
  ): Promise<void>;
  dispose(runId: RunId): Promise<unknown>;
  stopTask(runId: RunId, taskId: string): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  get(runId: RunId): RunHandle | undefined;
  isActive(runId: RunId): boolean;
}

export interface ConversationSettings {
  readonly profileId: ProfileId;
  readonly providerId: ProviderId;
  /** For the status bar; the id is what runs. */
  readonly profileLabel: string;
  readonly providerLabel: string;
  readonly cwd: string;
  /** Provider's own model id, or absent for the provider default. */
  readonly model?: string;
  readonly modelLabel?: string;
  readonly effort?: string;
  readonly fastMode?: boolean;
  readonly ultracode?: boolean;
  readonly permissionMode: PermissionMode;
}

export type ConversationStatus = 'idle' | 'starting' | 'running' | 'awaiting_permission';

/**
 * When a waiting message is expected to be read.
 *
 * `next-tool-break` is the one that happens: the provider accepted a steer and
 * will fold it in at its next tool boundary. `after-turn` would be a message
 * *Artemis* is sitting on until the turn ends, and no path here does that —
 * `send()` refuses a mid-turn message on a provider without `midRunSteering`
 * rather than parking the text, so the composer keeps the words and nothing is
 * queued. The kind is named anyway because the strip has to label whatever it
 * is handed, and a holding queue is the obvious next thing someone adds; a
 * label invented at that point would have to be invented in the component.
 */
export type QueuedDelivery = 'next-tool-break' | 'after-turn';

/** One message sent but not yet read, as the strip draws it. */
export interface QueuedMessage {
  /**
   * The identity the message was sent under — `${runId}:prompt:${n}`, the same
   * string the optimistic transcript row claims. It is what a
   * `message.delivered` names when the provider reads this one, so it is the
   * only thing that can strike the right entry rather than an arbitrary one.
   */
  readonly id: string;
  /** What was typed, whole. The strip truncates; the state does not. */
  readonly text: string;
  readonly delivery: QueuedDelivery;
  /** When it was sent, for a strip that may one day want to age a row. */
  readonly ts: number;
}

/**
 * What the agent is doing this very moment, in words.
 *
 * A turn used to be one undifferentiated `working…` from the first token to
 * the last, which answers neither of the two questions someone actually has
 * while they wait — *what* is it doing, and *is it still going*. Every other
 * terminal agent answers the first by promoting something the model already
 * said: Codex prints the reasoning header, Gemini the thought subject, Claude
 * Code the tool. So does this. Nothing here is invented or paraphrased — it is
 * the model's own first line, or the name of the tool it just reached for.
 *
 * `since` is when *this* text took the line, not when the turn began, which is
 * what makes "the same thought for 45 seconds" a thing the bar can notice.
 */
export interface ConversationActivity {
  readonly kind: 'thinking' | 'tool' | 'writing';
  /** Already one line and already short enough to print. */
  readonly text: string;
  /** Host clock when this text took the line. */
  readonly since: number;
}

export interface ConversationState {
  readonly settings: ConversationSettings;
  readonly status: ConversationStatus;
  readonly capabilities: Capabilities;
  readonly runId?: RunId;
  readonly sessionId?: SessionId;
  readonly usage?: UsageSnapshot;
  /** Open permission requests, oldest first. The card draws the first. */
  readonly pendingPermissions: readonly PermissionRequest[];
  /**
   * Steers accepted by the provider but not yet delivered to the model, oldest
   * first — which is also the order they will be read in.
   */
  readonly queuedMessages: readonly QueuedMessage[];
  /**
   * How many of {@link queuedMessages} there are, for the status line.
   *
   * Derived from the list rather than counted alongside it: a tally and a list
   * that can drift apart is the bug this list was built to end, and two
   * surfaces reading one array cannot disagree about a message.
   */
  readonly queued: number;
  /**
   * Background work, as the provider last reported it — a replacement list,
   * and one that outlives the turn: what is still running after `run.end` is
   * exactly what a person wants to know.
   */
  readonly tasks: readonly BackgroundTask[];
  /** The account's plan windows: fetched on request, kept current by `plan.limit` events mid-run. */
  readonly planUsage: PlanUsage | null;
  /**
   * The provider's own slash commands — built-in, bridged from the user's
   * directories, and from plugins — as the session last announced them. A
   * replacement list; known only once a session has started.
   */
  readonly slashCommands: readonly string[];
  /**
   * Host clock when the turn now running started, and absent when none is.
   *
   * The clock itself is not here — an elapsed *number* in the store would be a
   * write per second to move one digit, and every subscriber would re-render
   * for it. What is here is the fixed point a component's own clock subtracts
   * from, which is the same trade `DelegatedStrip` makes for its rows.
   */
  readonly turnStartedAt?: number;
  /** What the agent is doing right now. Absent until it has said something. */
  readonly activity?: ConversationActivity;
  /**
   * Output tokens this turn, when the provider has reported any mid-turn.
   *
   * Separate from {@link usage}, which accumulates across the whole
   * conversation and answers "what has this cost". This answers "how much has
   * it written since I pressed Enter", which is the reading that moves while
   * someone is watching it. Both Claude and Codex emit `delta` usage during a
   * turn — per assistant message and per token-count report respectively — so
   * this is real on both; a provider that reports nothing until `run.end`
   * leaves it undefined for the whole turn, and the bar simply omits it.
   */
  readonly turnTokens?: number;
}

export type Outcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface ConversationOptions {
  readonly driver: RunDriver;
  readonly settings: ConversationSettings;
  /** What the provider can do, before any run has told us. */
  readonly capabilitiesFor: (providerId: ProviderId) => Capabilities | undefined;
  readonly scheduler?: Scheduler;
  readonly newRunId?: () => RunId;
  /** The host clock, injected so a test can pin what "now" was. */
  readonly now?: () => number;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * How much of a thought or a tool call the line keeps.
 *
 * The status line shares its row with the elapsed time, the token count and
 * the key hints, and it is the half that truncates. Sixty characters is about
 * a reasoning header — "Investigating the rendering code" — and well short of
 * a sentence, which is the right place to stop: the transcript above has the
 * sentence.
 */
const ACTIVITY_CHARS = 60;

/**
 * A thinking block's first line, as a heading rather than as markdown.
 *
 * Models write their reasoning headers in the syntax they write everything
 * else in — `**Investigating rendering code**`, `## Checking the mapper` — and
 * the status line has no markdown renderer and should not grow one for this.
 * So the marks come off and the words stay. Whatever is left is the model's
 * own phrasing, never a paraphrase.
 *
 * Only the marks that are almost always markup: `*` and a backtick. An
 * underscore is left where it is, because a header naming `user_service.ts` is
 * far commoner than one set in italics, and a heading with the underscores
 * filed out of its filenames would be worse than one with a stray `_`.
 */
function heading(line: string): string {
  const bare = line
    .replace(/[*`]/g, '')
    .replace(/^\s*#+\s*/, '')
    .replace(/^\s*[>-]\s+/, '');
  return oneLine(bare, ACTIVITY_CHARS);
}

export class Conversation {
  readonly transcript: TranscriptModel;

  readonly #driver: RunDriver;
  readonly #capabilitiesFor: (providerId: ProviderId) => Capabilities | undefined;
  readonly #newRunId: () => RunId;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  readonly #eventListeners = new Set<(event: AgentEvent) => void>();
  readonly #unsubscribe: () => void;

  #settings: ConversationSettings;
  #capabilities: Capabilities;
  #status: ConversationStatus = 'idle';
  #runId: RunId | undefined;
  #sessionId: SessionId | undefined;
  #usage: UsageSnapshot | undefined;
  #pending: PermissionRequest[] = [];
  #queued: readonly QueuedMessage[] = [];
  #tasks: readonly BackgroundTask[] = [];
  #planUsage: PlanUsage | null = null;
  #slashCommands: readonly string[] = [];
  /** A run has reported its own commands, which outrank every seed. */
  #slashCommandsFromRun = false;
  #turnStartedAt: number | undefined;
  #activity: ConversationActivity | undefined;
  #turnTokens: number | undefined;
  /**
   * The heading of the last thinking block this turn opened, kept so that a
   * tool call can hand the line back to it when it finishes. Dropped the
   * moment the agent starts writing: by then the thought is spent, and
   * restoring it after the answer has begun would be the line going backwards.
   */
  #thinkingText: string | undefined;
  /**
   * The thinking block being read for a heading — its identity, the bytes seen
   * so far, and whether its first line is already known.
   *
   * This is the whole of the "keep it cheap" rule. A thinking block arrives as
   * hundreds of deltas and only its first line is ever printed, so once that
   * line is settled every further delta costs one boolean: no concatenation,
   * no scan, no new object, and therefore no new state snapshot either.
   */
  #thinkingBlock: { key: string; text: string; settled: boolean } | undefined;
  /** The tool call currently holding the line, so a sibling's end cannot take it. */
  #activeToolCallId: ToolCallId | undefined;
  /** The run that most recently ended; background work it started is stopped through it. */
  #lastRunId: RunId | undefined;
  /** Provider-started turns on this session that arrived while a turn of ours was open. See `#fromSibling`. */
  readonly #siblings = new Set<RunId>();
  #snapshot: ConversationState;

  constructor(options: ConversationOptions) {
    this.#driver = options.driver;
    this.#settings = options.settings;
    this.#capabilitiesFor = options.capabilitiesFor;
    this.#capabilities = options.capabilitiesFor(options.settings.providerId) ?? NO_CAPABILITIES;
    this.#newRunId = options.newRunId ?? (() => randomUUID() as RunId);
    this.#now = options.now ?? Date.now;
    this.transcript = new TranscriptModel(options.scheduler ?? frameScheduler);
    this.#snapshot = this.#buildSnapshot();
    this.#unsubscribe = this.#driver.subscribe((event) => this.#onEvent(event));
  }

  /* ---------------------------------------------------------------------- */
  /* Reading                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Immutable and reference-stable between changes — `useSyncExternalStore` wants exactly this. */
  getState = (): ConversationState => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Every event of *this* conversation's runs, after the transcript has seen it. */
  subscribeEvents = (listener: (event: AgentEvent) => void): (() => void) => {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  };

  get isLive(): boolean {
    return this.#runId !== undefined && this.#driver.isActive(this.#runId);
  }

  /* ---------------------------------------------------------------------- */
  /* Settings                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Change what the next turn runs with.
   *
   * A run belongs to the account it started on for its whole life, so the
   * account and provider cannot change while one is live. Changing them at all
   * ends the conversation: sessions live in the profile's own config directory
   * and a different account cannot resume this one. The caller is expected to
   * have asked first; this just makes the consequence real.
   */
  updateSettings(patch: Partial<ConversationSettings>): Outcome {
    const changesAccount =
      (patch.profileId !== undefined && patch.profileId !== this.#settings.profileId) ||
      (patch.providerId !== undefined && patch.providerId !== this.#settings.providerId);
    if (changesAccount && this.isLive) {
      return { ok: false, reason: 'A conversation belongs to the account it started on. Wait for this turn to finish.' };
    }
    this.#settings = { ...this.#settings, ...patch };
    if (changesAccount) {
      this.#sessionId = undefined;
      this.#usage = undefined;
      this.#endTurn();
      this.#capabilities = this.#capabilitiesFor(this.#settings.providerId) ?? NO_CAPABILITIES;
      this.transcript.reset();
    }
    this.#notify();
    return { ok: true };
  }

  /** Forget the session and clear the screen. Refused while a run is live. */
  reset(): Outcome {
    if (this.isLive) return { ok: false, reason: 'Wait for this turn to finish, or press Esc to interrupt it.' };
    this.#sessionId = undefined;
    this.#usage = undefined;
    this.#runId = undefined;
    this.#pending = [];
    this.#queued = [];
    this.#status = 'idle';
    this.#endTurn();
    this.transcript.reset();
    this.#notify();
    return { ok: true };
  }

  /* ---------------------------------------------------------------------- */
  /* Talking                                                                 */
  /* ---------------------------------------------------------------------- */

  async send(text: string, attachments: readonly Attachment[] = []): Promise<Outcome> {
    const prompt = text.trim();
    if (prompt.length === 0 && attachments.length === 0) return { ok: false, reason: 'Nothing to send.' };

    // Refused, not stripped: an image dropped on the way to the model turns
    // "what is wrong with this screenshot?" into a question about nothing,
    // and the answer comes back confident. The registry enforces the same.
    if (attachments.some((a) => a.kind === 'image') && !this.#capabilities.imageInput) {
      return { ok: false, reason: `${this.#settings.providerLabel} cannot take images.` };
    }
    if (attachments.some((a) => a.kind === 'file') && !this.#capabilities.fileInput) {
      return { ok: false, reason: `${this.#settings.providerLabel} cannot take file attachments.` };
    }

    const live = this.#runId;
    if (live !== undefined && this.#driver.isActive(live)) {
      if (!this.#capabilities.midRunSteering) {
        return {
          ok: false,
          reason: `${this.#settings.providerLabel} cannot take a message mid-turn. Wait for it to finish, or press Esc.`,
        };
      }
      return this.#steer(live, prompt, attachments);
    }
    return this.#startTurn(prompt, attachments);
  }

  /**
   * Take the newest waiting message off the list and hand its text back.
   *
   * What this cannot do, and must not pretend to: un-send it. `driver.send` has
   * already resolved, which means the provider is holding that message and will
   * read it at its next tool break whatever happens here — and `RunDriver` has
   * no retract, because the registry has none to expose and no adapter could
   * honour one invented at this layer. Nor does the transcript row go: the
   * message really was sent, and a row that vanished would be the screen lying
   * about it. Even Esc is not a cancel — the CLI's queue survives an interrupt
   * by design, so interrupting makes the message be read *sooner*.
   *
   * So what it is for is the honest half: Artemis stops counting the message as
   * outstanding, and the words come back into the composer where they can be
   * edited and sent again as the next turn's prompt. That is the whole of what
   * the strip's header offers, and the *newest* is the right one to offer —
   * it is the one still fresh in the typist's head, and the one the provider is
   * least likely to have reached already.
   */
  takeBackQueued(): string | undefined {
    const newest = this.#queued.at(-1);
    if (newest === undefined) return undefined;
    this.#queued = this.#queued.slice(0, -1);
    this.#notify();
    return newest.text;
  }

  /**
   * Replace the screen with a stored conversation and continue it.
   *
   * The events come from the provider's own store, already flagged `replay`,
   * and go through the same reducer live ones do — history and live output
   * share one rendering path by design. Refused while a run is live, because
   * the session id is about to be the one the next turn resumes.
   */
  loadHistory(sessionId: SessionId, events: readonly AgentEvent[]): Outcome {
    if (this.isLive) return { ok: false, reason: 'Wait for this turn to finish before switching conversations.' };
    this.transcript.reset();
    for (const event of events) this.transcript.apply(event);
    this.transcript.flush();
    this.#sessionId = sessionId;
    this.#usage = undefined;
    this.#runId = undefined;
    this.#pending = [];
    this.#queued = [];
    this.#status = 'idle';
    this.#endTurn();
    this.#notify();
    return { ok: true };
  }

  /**
   * Seed the provider's command list before any run has reported one.
   *
   * Ignored once a run *has* spoken, and only then: what a live session says
   * it has is the truth. Anything else — a list remembered from the last
   * launch, then the fresh one that replaces it a second later — is a
   * standing-in answer that a better standing-in answer may overwrite. See
   * `TuiHost.listCommands` for why the seed exists at all.
   */
  seedSlashCommands(commands: readonly string[]): void {
    if (this.#slashCommandsFromRun || commands.length === 0) return;
    this.#slashCommands = commands;
    this.#notify();
  }

  /** A fetched snapshot replaces whatever `plan.limit` events had folded. */
  setPlanUsage(usage: PlanUsage | null): void {
    this.#planUsage = usage;
    this.#notify();
  }

  /** Stop a background task, of this run or the one that just ended. */
  async stopTask(taskId: string): Promise<Outcome> {
    const runId = this.#runId ?? this.#lastRunId;
    if (runId === undefined) return { ok: false, reason: 'Nothing is running.' };
    try {
      await this.#driver.stopTask(runId, taskId);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: describe(error) };
    }
  }

  async interrupt(): Promise<void> {
    const runId = this.#runId;
    if (runId === undefined || !this.#driver.isActive(runId)) return;
    try {
      await this.#driver.interrupt(runId);
    } catch (error) {
      this.transcript.note('warn', `Could not interrupt: ${describe(error)}`);
    }
  }

  /**
   * Answer a permission prompt.
   *
   * One rule lives here rather than in the card: an *allow* that carries a
   * `setMode` update — which is what approving a plan does — changes the mode
   * the next turn starts in. Without this the next prompt would still run in
   * `plan` and the agent would refuse to edit anything, which reads as a
   * broken app rather than a mode. The desktop's `leavePlanMode` does the same.
   *
   * A request that is no longer open — withdrawn, or answered from elsewhere —
   * makes the driver throw; that means "drop the card", not "show an error".
   */
  async respondToPermission(requestId: PermissionRequestId, decision: PermissionDecision): Promise<void> {
    const runId = this.#runId;
    if (runId === undefined) return;
    if (decision.behavior === 'allow') {
      const setMode = decision.updatedPermissions?.find((update) => update.type === 'setMode');
      if (setMode !== undefined && setMode.type === 'setMode') {
        this.#settings = { ...this.#settings, permissionMode: setMode.mode };
      }
    }
    try {
      await this.#driver.respondToPermission(runId, requestId, decision);
    } catch {
      // Not open any more. The `permission.resolved` that explains why has
      // either arrived or never will; either way the card goes.
    } finally {
      this.#pending = this.#pending.filter((request) => request.id !== requestId);
      if (this.#status === 'awaiting_permission' && this.#pending.length === 0) this.#status = 'running';
      this.#notify();
    }
  }

  dispose(): void {
    this.#unsubscribe();
    this.#listeners.clear();
    this.#eventListeners.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* The two paths                                                           */
  /* ---------------------------------------------------------------------- */

  async #startTurn(prompt: string, attachments: readonly Attachment[] = [], carriedRow?: string): Promise<Outcome> {
    const runId = this.#newRunId();
    const messageId = `${runId}:prompt:1`;
    let rowId: string;
    if (carriedRow === undefined) {
      rowId = this.transcript.pushUserMessage(prompt, attachments.length > 0 ? attachments : undefined, messageId);
    } else {
      rowId = carriedRow;
      this.transcript.claimUserMessage(rowId, messageId);
    }

    this.#runId = runId;
    this.#status = 'starting';
    this.#pending = [];
    this.#queued = [];
    this.#beginTurn();
    this.#notify();

    const settings = this.#settings;
    const input: RunInput = {
      runId,
      providerId: settings.providerId,
      profileId: settings.profileId,
      cwd: settings.cwd,
      prompt,
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(settings.model === undefined ? {} : { model: settings.model }),
      ...(settings.effort === undefined ? {} : { effort: settings.effort }),
      ...(settings.fastMode === true ? { fastMode: true } : {}),
      ...(settings.ultracode === true ? { ultracode: true } : {}),
      ...(this.#sessionId === undefined ? {} : { resumeSessionId: this.#sessionId }),
      // Sent only when the provider really has the mode: an adapter rejects an
      // unknown one rather than downgrading it, and a stored preference must
      // not become an error on a provider with fewer modes.
      ...(this.#capabilities.permissionModes.includes(settings.permissionMode)
        ? { permissionMode: settings.permissionMode }
        : {}),
    };

    try {
      const handle = await this.#driver.start(input);
      this.#capabilities = handle.capabilities;
      this.transcript.confirmUserMessage(rowId);
      if (this.#status === 'starting') this.#status = 'running';
      this.#notify();
      return { ok: true };
    } catch (error) {
      const reason = describe(error);
      this.transcript.note('error', reason);
      if (this.#runId === runId) {
        this.#runId = undefined;
        this.#status = 'idle';
        this.#endTurn();
      }
      this.#notify();
      return { ok: false, reason };
    }
  }

  async #steer(runId: RunId, prompt: string, attachments: readonly Attachment[] = []): Promise<Outcome> {
    const handle = this.#driver.get(runId);
    const n = (handle?.promptCount ?? 1) + 1;
    const messageId = `${runId}:prompt:${n}`;
    const rowId = this.transcript.pushUserMessage(prompt, attachments.length > 0 ? attachments : undefined, messageId);
    try {
      const outcome =
        attachments.length > 0
          ? await this.#driver.send(runId, prompt, attachments)
          : await this.#driver.send(runId, prompt);
      this.transcript.confirmUserMessage(rowId);
      // Queued under the id the registry filed it as — the same one the row
      // above claimed, and the one a `message.delivered` will name. The
      // provider has taken it; nothing has seen it read it.
      if (!outcome.deliveredImmediately) {
        this.#queued = [
          ...this.#queued,
          { id: messageId, text: prompt, delivery: 'next-tool-break', ts: Date.now() },
        ];
      }
      this.#notify();
      return { ok: true };
    } catch (error) {
      // The steer raced the end of its run. The prompt is not lost: it opens
      // the next turn instead, and the row it already drew moves with it.
      if (!this.#driver.isActive(runId)) return this.#startTurn(prompt, attachments, rowId);
      const reason = describe(error);
      this.transcript.note('error', reason);
      this.#notify();
      return { ok: false, reason };
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Events                                                                  */
  /* ---------------------------------------------------------------------- */

  #onEvent(event: AgentEvent): void {
    if (event.runId !== this.#runId && !this.#adopt(event)) {
      if (!this.#fromSibling(event)) return;
      this.#onSiblingEvent(event);
      return;
    }
    this.transcript.apply(event);

    switch (event.type) {
      case 'session.started':
        this.#sessionId = event.sessionId;
        if (this.#status === 'starting') this.#status = 'running';
        // What the provider actually started in, which may differ from what
        // was asked for. The bar shows the truth.
        if (event.permissionMode !== undefined) {
          this.#settings = { ...this.#settings, permissionMode: event.permissionMode };
        }
        if (event.slashCommands !== undefined) {
          this.#slashCommands = event.slashCommands;
          this.#slashCommandsFromRun = true;
        }
        break;
      case 'session.commands':
        this.#slashCommands = event.slashCommands;
        this.#slashCommandsFromRun = true;
        break;
      case 'permission.request':
        this.#pending = [...this.#pending, event.request];
        this.#status = 'awaiting_permission';
        break;
      case 'permission.resolved':
        this.#pending = this.#pending.filter((request) => request.id !== event.requestId);
        if (this.#status === 'awaiting_permission' && this.#pending.length === 0) this.#status = 'running';
        break;
      case 'message.delivered':
        this.#deliver(event.messageId);
        break;
      case 'thinking.delta':
        this.#onThinking(event);
        break;
      case 'text.delta':
        // Text is the answer being written, whatever came before it. The
        // thought that led here is spent — see `#thinkingText`.
        if (event.agentId === undefined && event.text.length > 0) {
          this.#thinkingBlock = undefined;
          this.#thinkingText = undefined;
          this.#setActivity('writing', 'writing');
        }
        break;
      case 'tool.start': {
        if (event.agentId !== undefined) break;
        const target = summarizeToolInput(event.input);
        this.#activeToolCallId = event.toolCallId;
        this.#setActivity(
          'tool',
          oneLine(target.length > 0 ? `${event.name} ${target}` : event.name, ACTIVITY_CHARS),
        );
        break;
      }
      case 'tool.end':
        // Only the call that is actually on the line may take itself off it:
        // tools run in parallel, and the first of three to finish must not
        // blank a line describing one of the other two.
        if (event.agentId === undefined && event.toolCallId === this.#activeToolCallId) {
          this.#activeToolCallId = undefined;
          if (this.#thinkingText === undefined) this.#activity = undefined;
          else this.#setActivity('thinking', this.#thinkingText);
        }
        break;
      case 'usage':
        this.#foldUsage(event.usage);
        this.#foldTurnTokens(event.usage);
        break;
      case 'background.tasks':
        this.#tasks = event.tasks;
        break;
      case 'plan.limit': {
        // `null` means "nothing to fold onto" — a reading with no window — and
        // is not a reason to forget what was known.
        const folded = applyPlanLimit(this.#planUsage, event.limit, event.ts);
        if (folded !== null) this.#planUsage = folded;
        break;
      }
      case 'run.end': {
        if (event.sessionId !== undefined) this.#sessionId = event.sessionId;
        if (event.usage !== undefined) this.#foldUsage(event.usage);
        const ended = this.#runId;
        this.#lastRunId = ended;
        this.#runId = undefined;
        this.#status = 'idle';
        this.#pending = [];
        this.#queued = [];
        this.#endTurn();
        /*
         * And nothing else. The run is *not* disposed here, and that omission
         * is load-bearing.
         *
         * `dispose()` is the one call that overrules a provider's retention of
         * its process — `ClaudeRun.release` exists, as a deliberate no-op, to
         * stop the registry reaching for it at every turn boundary. Reaching
         * for it here killed the CLI the instant a turn ended, taking with it
         * every subagent the turn had left running in the background: the
         * `Agent` tool backgrounds by default, so "delegate this and carry on"
         * is the ordinary case, not an exotic one. The next turn then spawned a
         * fresh process whose ledger had never heard of the work, and reported
         * the conversation's own subagents as `stopped`, `0 tools`, `0 tokens`.
         *
         * The registry retires a finished run without help: the pump's
         * `finally` calls `#finalize`, which releases rather than disposes, and
         * the process then decides for itself whether it still holds work worth
         * staying open for. That decision is the whole of the feature; this
         * used to overrule it one line after it was made.
         */
        break;
      }
      default:
        break;
    }

    this.#notify();
    for (const listener of this.#eventListeners) listener(event);
  }

  /**
   * Take on a turn the provider started by itself, when it is this conversation's.
   *
   * The CLI speaks unprompted: told that background work settled it answers,
   * and a subagent that outlived its turn can park on a permission prompt. Those
   * turns are real runs, adopted by the registry (`host.ts`) under an id nothing
   * here minted — and routing is by run id, so without this every one of them
   * was dropped. What that looked like from the chair: the delegated strip
   * spinning on a subagent that had finished, and the agent's own sentence
   * about the result never arriving.
   *
   * The run's first event is the one that names the conversation, and the
   * session id is the whole test: this session, and not another conversation's
   * run on the same registry. Only while idle — a turn this conversation is
   * already running keeps its stream, as the desktop's pane does.
   */
  #adopt(event: AgentEvent): boolean {
    if (event.type !== 'session.started') return false;
    if (this.#runId !== undefined || this.#sessionId === undefined || event.sessionId !== this.#sessionId) return false;
    this.#runId = event.runId;
    this.#status = 'running';
    this.#pending = [];
    this.#queued = [];
    // A provider-started turn is still a turn someone is waiting through, and
    // its clock starts where we first heard of it — which is the only moment
    // available, since nothing here asked for it.
    this.#beginTurn();
    return true;
  }

  /**
   * Is this an event of a sibling — a provider-started turn on this session
   * that could not be adopted because a turn of ours was already open?
   *
   * The one window {@link #adopt} cannot cover: the next prompt is typed, the
   * CLI takes its settle turn first, and two runs of one session are alive at
   * once while `#runId` can hold only the prompt's. The sibling's first event
   * names the session, which is enough to remember it by; everything after is
   * matched on the id.
   */
  #fromSibling(event: AgentEvent): boolean {
    if (this.#siblings.has(event.runId)) return true;
    if (event.type !== 'session.started' || this.#sessionId === undefined || event.sessionId !== this.#sessionId) return false;
    this.#siblings.add(event.runId);
    return true;
  }

  /**
   * What a sibling's turn is allowed to change: the transcript, and the rows.
   *
   * Not the run lifecycle — status, permissions, the queue all describe the
   * prompt's own turn — and not its end: a sibling finishing says nothing
   * about ours. The CLI runs the two in series, so what the sibling says lands
   * before the prompt's answer, which is the order it actually happened in.
   */
  #onSiblingEvent(event: AgentEvent): void {
    this.transcript.apply(event);
    if (event.type === 'background.tasks') this.#tasks = event.tasks;
    if (event.type === 'run.end') this.#siblings.delete(event.runId);
    this.#notify();
    for (const listener of this.#eventListeners) listener(event);
  }

  /**
   * Strike the waiting message a `message.delivered` names.
   *
   * By id where one matches: the event carries the identity the message was sent
   * under, so this is the one case where the *right* entry can be removed rather
   * than a plausible one — and a provider that reads a later message first (it
   * decides the order, not us) is then reported correctly.
   *
   * Otherwise the oldest goes, and there is a real case for it: the id is
   * `promptCount + 1`, and an adopted run — one the provider started, which
   * {@link #adopt} takes on — reports no `promptCount` at all, so the steer
   * claims `:prompt:2` while the registry, whose own count is still at zero,
   * files it as `:prompt:1`. The delivery then names an id this list does not
   * hold. Dropping it would leave the strip showing a message the agent is
   * plainly acting on, which is the failure the list was built to end;
   * deliveries arrive in the order the provider reads them, so oldest-first is
   * wrong only about *which* row goes, never about how many.
   */
  #deliver(messageId: string): void {
    if (this.#queued.length === 0) return;
    const named = this.#queued.findIndex((message) => message.id === messageId);
    const gone = named === -1 ? 0 : named;
    this.#queued = this.#queued.filter((_, index) => index !== gone);
  }

  /* ---------------------------------------------------------------------- */
  /* What it is doing, and for how long                                      */
  /* ---------------------------------------------------------------------- */

  /** A turn is starting: the clock runs and everything the last one said goes. */
  #beginTurn(): void {
    this.#endTurn();
    this.#turnStartedAt = this.#now();
  }

  /** The turn is over: nothing is happening, so the line must not claim it is. */
  #endTurn(): void {
    this.#turnStartedAt = undefined;
    this.#activity = undefined;
    this.#turnTokens = undefined;
    this.#thinkingText = undefined;
    this.#thinkingBlock = undefined;
    this.#activeToolCallId = undefined;
  }

  /**
   * Put something on the line, and *only* when it is different.
   *
   * The reference has to survive an unchanged tick, because a fresh object per
   * delta would be a fresh state snapshot per delta, which is a re-render per
   * token of every subscriber of this store. It also keeps `since` honest: the
   * clock behind "the same thought for 45 seconds" must not be restarted by
   * the next token of that same thought.
   */
  #setActivity(kind: ConversationActivity['kind'], text: string): void {
    const current = this.#activity;
    if (current !== undefined && current.kind === kind && current.text === text) return;
    this.#activity = { kind, text, since: this.#now() };
  }

  /**
   * Read a heading out of a thinking block, once, and then stop reading it.
   *
   * Only the *first line* is ever wanted, so the block is accumulated only
   * until that line is known — either a newline arrives, or enough characters
   * have that the line would be clipped at {@link ACTIVITY_CHARS} anyway and
   * cannot change what is printed. Either way the answer settles once and the
   * rest of the block costs nothing. That is also what makes the printed text
   * stable: a partial first line grown a token at a time would rewrite the
   * status line on every frame with a word and a half of a header.
   *
   * A subagent's reasoning is skipped. `DelegatedStrip` already draws each
   * delegated agent on its own row, and letting a fan-out of three write to
   * the main line would make it flicker between three unrelated thoughts while
   * saying nothing about the agent that is actually being waited on.
   */
  #onThinking(event: ThinkingDeltaEvent): void {
    if (event.agentId !== undefined) return;
    const key = `${event.messageId}:${String(event.blockIndex)}`;
    let block = this.#thinkingBlock;
    if (block === undefined || block.key !== key) {
      block = { key, text: '', settled: false };
      this.#thinkingBlock = block;
    } else if (block.settled) {
      return;
    }

    // Leading blank lines are not a heading: a block that opens with one would
    // otherwise settle on an empty string and never say anything again.
    block.text = (block.text + event.text).replace(/^\s+/, '');
    const stop = block.text.indexOf('\n');
    if (stop === -1 && block.text.length < ACTIVITY_CHARS) return;

    block.settled = true;
    const text = heading(stop === -1 ? block.text : block.text.slice(0, stop));
    if (text.length === 0) return;
    this.#thinkingText = text;
    this.#setActivity('thinking', text);
  }

  /**
   * Output tokens this turn.
   *
   * `scope` says how: `delta` events add up, and `cumulative`/`final` are
   * already the whole of the run — and a run *is* a turn here, which is the
   * one rule this file is built around, so a cumulative figure needs no
   * subtraction to become a turn's figure. Ignored when no turn is running,
   * since a late `usage` belongs to the turn that has already been cleared.
   */
  #foldTurnTokens(usage: UsageSnapshot): void {
    if (this.#turnStartedAt === undefined) return;
    const output = usage.tokens.outputTokens;
    this.#turnTokens = usage.scope === 'delta' ? (this.#turnTokens ?? 0) + output : output;
  }

  /** `delta` adds to the running total; `cumulative` and `final` replace it. */
  #foldUsage(usage: UsageSnapshot): void {
    const current = this.#usage;
    if (usage.scope !== 'delta' || current === undefined) {
      this.#usage = usage;
      return;
    }
    const add = (a: number | undefined, b: number | undefined): number | undefined =>
      a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
    this.#usage = {
      ...current,
      ...usage,
      scope: 'cumulative',
      tokens: {
        inputTokens: current.tokens.inputTokens + usage.tokens.inputTokens,
        outputTokens: current.tokens.outputTokens + usage.tokens.outputTokens,
        ...(add(current.tokens.cacheReadInputTokens, usage.tokens.cacheReadInputTokens) === undefined
          ? {}
          : { cacheReadInputTokens: add(current.tokens.cacheReadInputTokens, usage.tokens.cacheReadInputTokens) as number }),
        ...(add(current.tokens.cacheCreationInputTokens, usage.tokens.cacheCreationInputTokens) === undefined
          ? {}
          : { cacheCreationInputTokens: add(current.tokens.cacheCreationInputTokens, usage.tokens.cacheCreationInputTokens) as number }),
      },
      ...(add(current.costUsd, usage.costUsd) === undefined ? {} : { costUsd: add(current.costUsd, usage.costUsd) as number }),
    };
  }

  #buildSnapshot(): ConversationState {
    return {
      settings: this.#settings,
      status: this.#status,
      capabilities: this.#capabilities,
      ...(this.#runId === undefined ? {} : { runId: this.#runId }),
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      ...(this.#usage === undefined ? {} : { usage: this.#usage }),
      pendingPermissions: this.#pending,
      queuedMessages: this.#queued,
      queued: this.#queued.length,
      tasks: this.#tasks,
      planUsage: this.#planUsage,
      slashCommands: this.#slashCommands,
      ...(this.#turnStartedAt === undefined ? {} : { turnStartedAt: this.#turnStartedAt }),
      ...(this.#activity === undefined ? {} : { activity: this.#activity }),
      // Zero is not a reading. A provider that has reported usage whose output
      // count is still nothing has told us nothing worth a column.
      ...(this.#turnTokens === undefined || this.#turnTokens <= 0
        ? {}
        : { turnTokens: this.#turnTokens }),
    };
  }

  /**
   * Publish, unless nothing observable moved.
   *
   * Every event that belongs to this conversation lands here, including each
   * one of the hundreds of text and thinking deltas in a turn — and before
   * this comparison each of those replaced the snapshot with an object that
   * was new but not different, which is a render of the whole app per token.
   * The transcript never had that problem: its model coalesces into one flush
   * per frame (`frameScheduler`) and notifies only what changed. This is the
   * same discipline for the other half of the screen, and it is what lets the
   * activity line be computed on every delta without costing anything — a
   * thought whose heading has already settled produces an identical snapshot
   * and no notification at all, so the status line moves when the transcript
   * does rather than once per token.
   *
   * Field-by-field and by reference, which is sound because every one of these
   * is replaced wholesale when it changes; `queued` is omitted because it is
   * derived from `queuedMessages`.
   */
  #notify(): void {
    const next = this.#buildSnapshot();
    const previous = this.#snapshot;
    const same =
      next.settings === previous.settings &&
      next.status === previous.status &&
      next.capabilities === previous.capabilities &&
      next.runId === previous.runId &&
      next.sessionId === previous.sessionId &&
      next.usage === previous.usage &&
      next.pendingPermissions === previous.pendingPermissions &&
      next.queuedMessages === previous.queuedMessages &&
      next.tasks === previous.tasks &&
      next.planUsage === previous.planUsage &&
      next.slashCommands === previous.slashCommands &&
      next.turnStartedAt === previous.turnStartedAt &&
      next.activity === previous.activity &&
      next.turnTokens === previous.turnTokens;
    if (same) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}
