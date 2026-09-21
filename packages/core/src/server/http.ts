/**
 * The server itself: routing, auth, and a socket.
 * ============================================================================
 *
 * Two layers, split so that the interesting half can be tested without a port.
 * {@link handleServerRequest} is a function from a request to a response —
 * every routing and authorisation decision lives there, and a test calls it
 * directly. {@link createArtemisServer} is the thin part that owns a
 * `node:http` server, counts traffic and turns the result into bytes.
 *
 * ---------------------------------------------------------------------------
 * WHAT GUARDS THIS PORT
 * ---------------------------------------------------------------------------
 *
 * Three checks, in this order, and each covers a hole the others do not.
 *
 * **1. The Host header must name loopback.** The socket is bound to
 * `127.0.0.1`, which stops another machine connecting — and does nothing about
 * DNS rebinding, where a page the user is looking at resolves an attacker's
 * hostname to `127.0.0.1` and then talks to this port from inside their
 * browser. The request arrives on loopback and looks local. What it cannot fake
 * is the `Host` header, which still says `evil.example`, so that is what is
 * checked.
 *
 * **2. A bearer token, compared in constant time.** The token is the only thing
 * separating a program the user configured from every other process on the
 * machine. `===` on a secret leaks its length and its matching prefix to
 * anything that can time the reply, which over loopback is everything, so the
 * comparison is `timingSafeEqual`.
 *
 * **3. Methods are enumerated, not assumed.** `GET`, `HEAD` and `OPTIONS` read;
 * exactly one `POST` route runs a turn, and it is named explicitly rather than
 * reached by relaxing the gate. Every other path answers `405` — or `404`, when
 * the path does not exist at all, since "wrong verb" on a route this server has
 * never heard of sends the caller looking for the right one.
 *
 * `OPTIONS` is exempt from the token and cannot be otherwise: a CORS preflight
 * is sent by the browser before the request that carries the credential, so a
 * server that demanded one would fail every browser client at the first hop. It
 * is safe because a preflight response carries no data — it only says which
 * requests *would* be allowed, and those are still checked when they arrive.
 *
 * ---------------------------------------------------------------------------
 * WHY CORS IS OPEN
 * ---------------------------------------------------------------------------
 *
 * `Access-Control-Allow-Origin: *`, which looks alarming and is not, because of
 * one property: this server has **no ambient authority**. There is no cookie,
 * no session, nothing the browser attaches on its own. Every request is
 * authorised by a token the caller must already know, so a hostile page that
 * reaches the port gets a 401 exactly as a hostile `curl` does, and a friendly
 * web client — a local dashboard, a browser-based editor — works without a
 * proxy. `Allow-Credentials` is deliberately absent, which is what keeps that
 * true.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import type { PlanUsage } from '@rx-artemis/protocol';
import type {
  AgentEvent,
  ArtemisChatExtensions,
  Attachment,
  Capabilities,
  OpenAiChatChunk,
  OpenAiChatRequest,
  OpenAiModelList,
  ProviderId,
  RunHandle,
  RunId,
  RunsInterruptResponse,
  RunsRespondPermissionResponse,
  RunsSendResponse,
  ServerHealthBody,
  ServerMemoryBank,
  ServerMemoryBankAccount,
  ServerMemoryBankBody,
  ServerMemoryBankScope,
  ServerMemoryBanksBody,
  ServerModel,
  ServerModelsBody,
  ServerConnection,
  ServerCommandsAccount,
  ServerCommandsBody,
  ServerProfile,
  ServerProfileCreatedBody,
  ServerProfilesBody,
  ServerRoutineBody,
  ServerRoutineDeletedBody,
  ServerRoutinesBody,
  ServerSessionDeletedBody,
  ServerSkillsBody,
  ServerUsageBody,
  ServerSessionMessagesBody,
  ServerSessionRenamedBody,
  ServerSessionsBody,
  ServerSessionTaggedBody,
  ServerSessionSummary,
  RoutineDraft,
  RoutinePatch,
  SessionSummary,
  SkillInfo,
  SkillSourceStatus,
} from '@rx-artemis/protocol';
import {
  ATTACHMENT_WIRE_BYTES,
  AttachmentError,
  CHAT_EXTENSIONS_FIELD,
  DEFAULT_SKILL_SOURCE_SUBDIR,
  SERVER_API_VERSION,
  SERVER_HEALTH_PATH,
  SERVER_HOST,
  SSE_DONE,
  SSE_HEARTBEAT,
  connectionHasExpired,
  describeConnection,
  isFileAttachment,
  isImageAttachment,
  mergeAttachments,
  parseModelRoute,
  readAttachments,
  readChatExtensions,
  reviewParameters,
  skillSourceSubdirProblem,
  skillSourceUrlProblem,
  sseEvent,
  visibleToConnection,
} from '@rx-artemis/protocol';

import type { Catalogue } from './catalogue.js';
import {
  attachmentsFromMessages,
  chatChunk,
  chatResponse,
  promptFromMessages,
  resumeTurn,
  runTurn,
  steerTurn,
  type ResumeRequest,
  type RunSource,
  type SteerRequest,
  type TurnEvent,
  type TurnResult,
} from './completions.js';
import { RunError } from '../sessions/errors.js';
import type { RemoteAccessEvent } from '../sessions/lifecycleLog.js';
import type { BrowserRelay } from './browserRelay.js';
import type { PushFeed } from './feed.js';
import type { RemoteRunGuard } from './guard.js';
import { workspaceKeyFor, type LedgerScope, type SessionLedger } from './ledger.js';
import type { ServerRoutineStore } from './routines.js';
import { resolveResumeModel, type RouteRedirect } from './sessionHome.js';
import { handleRemoteRequest, isRemotePath, type RemoteStreamOptions } from './remote.js';
import { CORS_HEADERS, JSON_HEADERS, fail, ok } from './replies.js';
import { createRunDirectory, reviewPermissionDecision, type RunDirectory } from './runs.js';
import {
  createSignInDirector,
  DuplicateProfileLabelError,
  SignInBusyError,
  SignInNotWaitingError,
  SignInUnavailableError,
  type ProfileAdmin,
  type SignInDirector,
} from './signin.js';
import type { RemoteTerminals } from './terminals.js';
import { WorkspaceUnavailableError, type WorkspaceResolver } from './workspaces.js';

/* -------------------------------------------------------------------------- */
/* The request/response shapes the router works in                            */
/* -------------------------------------------------------------------------- */

/** One request, reduced to what routing and auth actually read. */
export interface ServerRequestInfo {
  readonly method: string;
  /** Path and query, as it arrived on the wire: `/v1/models?refresh=1`. */
  readonly url: string;
  /** Lower-cased header names, as `node:http` already delivers them. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /**
   * The parsed JSON body, for the one route that has one.
   *
   * Read and parsed by the socket layer rather than here, so the router stays a
   * pure function of its inputs and a test can hand it an object instead of a
   * stream.
   */
  readonly body?: unknown;
  /**
   * The body was refused for its size before it was ever parsed.
   *
   * Carried as its own flag rather than left to be inferred from a missing
   * `body`, because the two need different answers and for years got the same
   * one: a body that is not JSON is a caller who sent the wrong thing, and a
   * body that is too large is a caller who sent the right thing and too much of
   * it. Both arrived here as `body: undefined` and were answered `400 The
   * request body must be a JSON object`, which sent everyone who ever attached
   * a screenshot to a served conversation looking for a bug in their JSON.
   */
  readonly bodyOversize?: boolean;
  /** Aborts when the client hangs up mid-turn. */
  readonly signal?: { readonly aborted: boolean };
}

/** What the router decided. `body` is JSON-serialisable or `null` for no content. */
export interface ServerReply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  /**
   * Which connection answered, when one did.
   *
   * Carried out so the socket layer can stamp `lastUsedAt` without re-deriving
   * the match — and so it never has to look at a token to do it.
   */
  readonly connectionId?: string;
  /**
   * The request was refused for a bad or missing token.
   *
   * Surfaced separately from the status code so the traffic counter can report
   * it without re-deriving intent from a number — a 401 from auth and a 404
   * from a typo are different news for the user watching the pane.
   */
  readonly rejected?: boolean;
}

/** What the router needs besides the request. */
export interface ServerContext {
  /**
   * Every configured connection. A request authenticates as exactly one.
   *
   * A list rather than a single token because the token *is* the identity here:
   * it decides which directory a turn runs in and which accounts are reachable.
   * See {@link ServerConnection}.
   */
  readonly connections: readonly ServerConnection[];
  /** Artemis's version, reported by `/health` and the index. */
  readonly version: string;
  readonly catalogue: Catalogue;
  /**
   * Epoch ms the server started listening.
   *
   * OpenAI's model rows carry a `created` timestamp and clients do parse it.
   * Artemis has nothing truthful to put there — a route is not a thing with a
   * creation date — so it reports when this server came up, which is at least a
   * real event and is stable for the lifetime of the process.
   */
  readonly startedAt: number;
  /**
   * How to run a turn, when this build can.
   *
   * Absent means the completions surface answers `501` — which is what a
   * catalogue-only deployment does, and what every test that is not about
   * running turns gets.
   */
  readonly runs?: RunSource;
  /**
   * Which connection owns which *completions-started* run, and the deadlines on
   * the ones nobody is watching.
   *
   * Absent means a turn is over when its request is: the detach opt-in is inert
   * (there would be nothing to hand the run to) and the three completions-run
   * actions answer `404`, indistinguishably from a build that never had them.
   *
   * Deliberately not the remote bridge's registry. Bridge-started runs are
   * governed by {@link guard}, on a different clock, and no run is ever in
   * both — see `runs.ts`.
   */
  readonly runDirectory?: RunDirectory;
  /** Where a connection's turns run. Required alongside {@link runs}. */
  readonly workspaces?: WorkspaceResolver;
  /**
   * Who owns which server-created session. Required for the session surface
   * and for the resume gate; absent means this build has no session history
   * to offer and no resumes to referee (a catalogue-only server).
   */
  readonly ledger?: SessionLedger;
  /** How to read each account's plan gauge. Absent answers 501. */
  readonly usage?: UsageSource;
  /** How to enumerate an account's slash commands. Absent answers 501. */
  readonly commands?: CommandSource;
  /** How to read stored sessions. Required alongside {@link ledger}. */
  readonly sessions?: SessionSource;
  /**
   * Routines that fire *in the server*, scoped per connection.
   *
   * Absent means this build keeps no server-side schedule and the routine
   * routes answer `501` — a catalogue-only deployment, or a test that is not
   * about routines. Present, it is the store the routes read and write, and its
   * scheduler is the thing that fires an appointment with every client closed.
   */
  readonly routines?: ServerRoutineStore;
  /**
   * Host-header names this server answers to, besides the loopback set.
   *
   * The Host check is DNS-rebinding protection for a loopback-bound server: a
   * hostile page can make a browser send requests to 127.0.0.1, but not with
   * an arbitrary `Host`. A server deliberately bound to a reachable address —
   * the headless deployment behind Tailscale — is asked for by other names,
   * and its operator says which. `'any'` disables the check entirely, for a
   * bind whose reachability is already governed elsewhere (a container's
   * published port, a VPN); it never weakens auth, which every request still
   * carries per-connection.
   */
  readonly allowedHosts?: readonly string[] | 'any';
  /**
   * Whether a served run may be connected to a Chrome.
   *
   * The operator's say, and `undefined` is no. `artemis.chromeBrowser` pairs a
   * run with the Chrome signed in as the *serving account*, so allowing it lets
   * every connection that may use an account act in that account owner's
   * browser - their logged-in sessions, not the host's workspace. That is the
   * operator's to decide and nobody else's: the headless server reads
   * `ARTEMIS_ALLOW_CHROME_BROWSER`; a host that never sets this declines.
   */
  readonly allowChromeBrowser?: boolean;
  /**
   * Whether a served run may drive the *caller's own* browser, through the
   * client that sent the request.
   *
   * Defaulted **on** by the headless server, which is the opposite of
   * {@link allowChromeBrowser} and for a reason worth stating: that one
   * reaches a Chrome signed in as the serving account, on the serving machine,
   * so allowing it lets a connection act in somebody else's browser. This one
   * reaches a browser paired with the client that made the request, over the
   * connection that request arrived on — the caller is asking a run they
   * started to use a browser only their own client can reach, which is a
   * smaller thing than the workspace access they already have. The env var is
   * an off switch (`ARTEMIS_ALLOW_CLIENT_BROWSER=0`) rather than an on switch,
   * for an operator who wants the server's runs to touch no browser at all.
   *
   * `undefined` is *on*, so a host that never sets it — the desktop's own
   * server — behaves as the headless one does.
   */
  readonly allowClientBrowser?: boolean;
  /**
   * Where a served run's browser verbs go, and where their answers arrive.
   *
   * Absent means this build has no relay, and `artemis.extensionBrowser` is
   * declined and reported. See `browserRelay.ts`.
   */
  readonly browserRelay?: BrowserRelay;
  /**
   * The push feed the event stream serves. Absent means this build has no
   * live feed to offer and `/api/v0/events` answers `501` — a catalogue-only
   * deployment, and every test that is not about the stream.
   */
  readonly feed?: PushFeed;
  /** Tuning for the event stream. Injected by tests; defaults apply live. */
  readonly remoteStream?: RemoteStreamOptions;
  /**
   * Interrupt-on-disconnect for bridge-started runs. Absent means no such
   * policy — which a host that also provides no control verbs honestly has.
   */
  readonly guard?: RemoteRunGuard;
  /**
   * The configured connections, read *live* rather than as this request's
   * snapshot.
   *
   * Every route is answered from {@link connections}, which is the snapshot
   * taken when the request arrived, and for a request that is the same thing.
   * A *stream* is not a request: it is open for hours, and the snapshot it was
   * born with says a token is valid long after the user revoked it or its
   * expiry passed. `deleteConnection` promises revocation takes effect on the
   * next request with no restart; a stream that keeps delivering transcripts
   * and PTY bytes to a deleted token breaks that promise in the worst possible
   * direction. This is how the stream re-asks. Absent means it cannot, and it
   * falls back to the snapshot — which is what every test that builds a context
   * by hand does.
   */
  readonly connectionsNow?: () => readonly ServerConnection[];
  /**
   * Shells a remote window may open on this machine. Absent means this
   * deployment has no PTY to offer and the terminal routes answer `501` —
   * which the headless server honestly does, and which a remote client renders
   * as an empty dock rather than an error.
   */
  readonly terminals?: RemoteTerminals;
  /**
   * The attribution record: which token did what.
   *
   * Absent means nothing is written, which is what every pre-remote build did.
   * Present, it is handed acts only — starting and steering runs, answering
   * permission prompts, opening and closing shells, and a token presented past
   * its expiry — never reads, and never anything carrying content. See
   * `sessions/lifecycleLog.ts` for the record's shape and the redaction rule
   * that is enforced rather than promised.
   */
  readonly onRemoteAccess?: (event: RemoteAccessEvent) => void;
  /**
   * How to add a serving account, when this build can.
   *
   * Absent means the account-administration surface answers `501` — a
   * catalogue-only server, or a desktop-hosted one whose accounts are managed
   * in a window instead. Required alongside {@link signIns}: an account nobody
   * can sign in is half a feature.
   */
  readonly profileAdmin?: ProfileAdmin;
  /** The one sign-in this server will drive at a time. See `signin.ts`. */
  readonly signIns?: SignInDirector;
  /**
   * This machine's memory-bank registry, for the surface that scopes a bank to
   * some of its accounts. Absent answers `501` to an administrator and `404`
   * to everyone else, exactly as {@link profileAdmin} does.
   */
  readonly memoryBanks?: MemoryBankAdmin;
  /**
   * The skills this machine carries and the repositories it clones them from.
   * Absent answers `501`: a host that bridges no skills has nothing to list.
   */
  readonly skills?: SkillsAdmin;
  /**
   * Where a run that failed is recorded on the serving machine.
   *
   * Separate from a transport fault: this one *did* reach its caller, as a
   * reason on the final chunk. It is reported here as well because the two
   * audiences are different people — the caller learns their turn failed, and
   * whoever runs the server learns that an account it serves is broken, which
   * until now it had no way to find out. A server whose only account failing is
   * a signed-out one should not need a packet capture to say so.
   */
  readonly onRunFailure?: (error: unknown) => void;
}

/**
 * The host's session store, reduced to what the routes make of it.
 *
 * The same narrowing discipline as {@link RunSource}: the server touches
 * exactly what its ledger authorises, and nothing here lists across profiles.
 * The three writes are optional — a host wires them only where the serving
 * adapter really can rename, delete or tag, and a route whose method is
 * absent answers 501 rather than pretending.
 */
export interface SessionSource {
  list(query: {
    readonly providerId: string;
    readonly profileId: string;
    readonly cwd: string;
    readonly limit?: number;
  }): Promise<{ readonly sessions: readonly SessionSummary[]; readonly hasMore: boolean }>;
  messages(query: {
    readonly profileId: string;
    readonly sessionId: string;
    readonly runId: string;
    readonly cwd?: string;
    /** Page size in stored messages; the whole conversation when absent. */
    readonly limit?: number;
    /** Page offset in stored messages. Defaults to 0. */
    readonly offset?: number;
  }): Promise<{ readonly events: readonly AgentEvent[]; readonly hasMore: boolean }>;
  /**
   * Store a title against a session, exactly as a local rename would.
   *
   * Returns the title as stored — trimmed and capped by the host — because
   * the route's reply shows the caller what the store now says.
   */
  rename?(query: {
    readonly profileId: string;
    readonly sessionId: string;
    readonly title: string;
    readonly cwd?: string;
  }): Promise<{ readonly title: string }>;
  /** Destroy a stored transcript. False when there was nothing to remove. */
  delete?(query: {
    readonly profileId: string;
    readonly sessionId: string;
    readonly cwd?: string;
  }): Promise<boolean>;
  /** Write or clear the provider's own tag. False when nothing was there. */
  tag?(query: {
    readonly profileId: string;
    readonly sessionId: string;
    readonly tag: string | null;
    readonly cwd?: string;
  }): Promise<boolean>;
}

/**
 * The host's plan-usage reads, one per account, cached where they are made.
 *
 * A method rather than rows, because freshness is the host's business: the
 * reading costs a CLI control call per account, so the host answers from a
 * short cache and refreshes behind it. `undefined` marks a host that cannot
 * read gauges at all, and the route answers 501.
 */
export interface UsageSource {
  read(query: {
    readonly profileIds: readonly string[];
  }): Promise<readonly { readonly profileId: string; readonly label: string; readonly usage: PlanUsage }[]>;
}

/**
 * The host's slash-command reads: what a session on one account would offer.
 *
 * A method rather than a list, for the reason {@link UsageSource} is: the
 * answer costs a provider control call per account — the CLI is opened and
 * asked, never prompted — so the host decides what "fresh enough" means and
 * answers from its own cache. `cwd` is the directory a turn on the asking
 * connection would run in, when the connection has one; the host substitutes
 * somewhere that exists when it does not. `undefined` marks a host that
 * cannot enumerate commands at all, and the route answers 501.
 *
 * Resolves rather than rejects, on the contract `ProviderAdapter.listCommands`
 * states: an account whose CLI is away answers an empty list.
 */
export interface CommandSource {
  list(query: {
    readonly profileId: string;
    readonly providerId: string;
    readonly cwd?: string;
  }): Promise<readonly string[]>;
}

/**
 * The serving machine's memory-bank registry, reduced to what the routes make
 * of it: read every bank, and change which accounts one of them reaches.
 *
 * Deliberately not the whole of `memory-banks.json`. Adding, forgetting,
 * cloning and pulling a bank are jobs for whoever administers the serving
 * machine — they touch its disk and its git credentials — and none of them is
 * what a remote client is missing. What it *is* missing is the one field the
 * CLI registry has no room for and nothing on the wire could reach: the scope.
 * So this seam is a read and one write.
 */
export interface MemoryBankAdmin {
  /** Every bank in the registry, in registry order, scope included. */
  list(): Promise<readonly ServerMemoryBank[]>;
  /**
   * Replace one bank's account scope and persist it.
   *
   * `undefined` when no bank has that slug, which the route turns into the
   * same 404 an unknown account gets — said only to a caller who already holds
   * the administrative grant.
   */
  setScope(slug: string, scope: ServerMemoryBankScope): Promise<ServerMemoryBank | undefined>;
}

/**
 * The serving machine's skills, and the repositories it keeps cloned to get
 * them.
 *
 * Wider than {@link MemoryBankAdmin} on purpose, and the difference is what is
 * being administered. A memory bank is cloned with a person's credentials and
 * written to by agents, so adding one stays a job for whoever sits at the
 * serving machine. A skill source is a read-only cache of a repository, pulled
 * with whatever access the machine already has and refused outright when its
 * URL carries a credential — and the point of one is to have the same skills
 * on every machine, which a server nobody sits at cannot otherwise join. So
 * the whole lifecycle is here: list, add, pull, remove.
 *
 * What a source *is* does not widen what the grant already allows. A token
 * that may administer this machine can add an account and run an agent on it,
 * which can write any skill it likes; choosing which repository the server
 * reads skills from is a smaller power than that, not a larger one.
 *
 * Every method resolves. A source that cannot be cloned is stored and reported
 * with its error, the way the desktop's pane does it, so the caller sees the
 * reason against the row rather than a request that failed.
 */
export interface SkillsAdmin {
  /**
   * What a run could be offered. `profileIds` narrows the account folders that
   * are read to the accounts the asking connection can see; the machine-wide
   * folder and the sources reach every account and are always read.
   */
  list(query: { readonly profileIds: readonly string[] }): Promise<{
    readonly skills: readonly SkillInfo[];
    readonly sources: readonly SkillSourceStatus[];
  }>;
  /**
   * Store a source and clone it. The URL and folder are already validated.
   *
   * Answers a sentence when the source cannot be *stored* — the list is full —
   * and `null` otherwise. A clone that fails is not that: the source is kept
   * and the reason is reported against its row.
   */
  addSource(source: { readonly url: string; readonly subdir: string }): Promise<string | null>;
  /** False when no source has that id. */
  removeSource(id: string): Promise<boolean>;
  /** Pull one source, or all of them. False when an id was given and is unknown. */
  syncSources(id?: string): Promise<boolean>;
}

/** True when this reply is written incrementally rather than as one body. */
export function isStreamReply(reply: ServerReply | ServerStreamReply): reply is ServerStreamReply {
  return 'stream' in reply;
}

/** A reply that is written as a stream of events rather than one JSON body. */
export interface ServerStreamReply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly connectionId?: string;
  /** Each yielded string is written and flushed as it arrives. */
  readonly stream: AsyncIterable<string>;
}

/* -------------------------------------------------------------------------- */
/* Routing                                                                    */
/* -------------------------------------------------------------------------- */

/** Hosts a request may legitimately claim to have been sent to. See the file comment. */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Endpoints this server intends to have and does not have yet.
 *
 * Listed so they can answer `501` with a sentence instead of falling through to
 * a bare `404` — see where this is used. The list is the OpenAI surface a
 * client is most likely to reach for the moment it has a model id in hand, and
 * each entry comes off it as it is implemented.
 */
const PLANNED_PATHS = new Set(['/v1/completions', '/v1/responses', '/v1/embeddings']);

/** The one path that runs a turn. */
const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';

/**
 * The largest request body this server will read.
 *
 * A megabyte is far more than a conversation needs and far less than a caller
 * could use to exhaust memory. The cap exists because body size is the one
 * resource an authenticated client controls directly.
 */
const MAX_BODY_BYTES = 1_000_000;

/**
 * The routes that may carry attachments, and so may be larger.
 *
 * A megabyte is not "far more than a conversation needs" once a conversation
 * can include a screenshot: base64 adds a third to a payload that is already
 * megabytes, so under the flat cap every real image was answered with `400 The
 * request body must be a JSON object` — a message about JSON, for a body that
 * was perfectly good JSON and merely large. Nothing in the reply said so, which
 * is why this was read as "the server cannot take attachments" rather than as a
 * limit.
 *
 * Listed rather than derived from the method, because the widening should be
 * exactly as wide as the feature that needs it: these four routes hand their
 * bodies to `readAttachments`, and every other route on this server keeps the
 * cap it has always had.
 */
const ATTACHMENT_BODY_PATHS: readonly string[] = [
  CHAT_COMPLETIONS_PATH,
  `/api/${SERVER_API_VERSION}/runs`,
];

/** The cap for one request: the wide one only where attachments may ride. */
function bodyCapFor(path: string): number {
  const route = path.split('?')[0] ?? path;
  const wide =
    ATTACHMENT_BODY_PATHS.includes(route) ||
    // `POST /api/v0/runs/{id}/messages` and the bridge's `/send`: the same
    // attachments, into a run that is already going.
    /^\/api\/[^/]+\/runs\/[^/]+\/(?:messages|send)$/.test(route);
  return wide ? ATTACHMENT_WIRE_BYTES : MAX_BODY_BYTES;
}

/**
 * Answer one request.
 *
 * Never throws: a fault becomes a 500 with an error body, because a rejected
 * promise here would take out the socket rather than the request.
 */
export async function handleServerRequest(
  request: ServerRequestInfo,
  context: ServerContext,
): Promise<ServerReply | ServerStreamReply> {
  const method = request.method.toUpperCase();

  // Preflight first, before anything that could 401 or 404 it — see the file
  // comment on why this one cannot carry a token.
  if (method === 'OPTIONS') {
    return { status: 204, headers: { ...CORS_HEADERS }, body: null };
  }

  if (!hostAllowed(request.headers['host'], context.allowedHosts)) {
    // Deliberately curt. A caller that reached this branch is either a
    // rebinding attempt or a proxy misconfiguration, and neither deserves a
    // description of what the server would have accepted.
    return fail(403, 'invalid_request_error', 'forbidden_host', 'This server does not answer to that host name.');
  }

  // Parsed against a fixed base: `request.url` is a path, not an absolute URL,
  // and the base is never used for anything but making `URL` willing to parse.
  let url: URL;
  try {
    url = new URL(request.url, 'http://localhost');
  } catch {
    return fail(400, 'invalid_request_error', 'invalid_url', 'The request path could not be parsed.');
  }
  const path = normalizePath(url.pathname);

  /*
   * Too large, answered before the route is even found.
   *
   * Ahead of authentication on purpose, and it gives nothing away: the socket
   * layer has already refused to read the body, so there is nothing left to do
   * with this request whoever sent it, and a caller who has to guess whether
   * their token or their payload was the problem is a caller who will guess
   * wrong. The cap named in the message is the one this route actually has,
   * which is how a client learns that the wide one exists.
   */
  if (request.bodyOversize === true) {
    const cap = bodyCapFor(path);
    return fail(
      413,
      'invalid_request_error',
      'payload_too_large',
      `The request body is larger than this route accepts (${String(cap)} bytes). ${
        cap === MAX_BODY_BYTES
          ? 'Only the routes that start or steer a run carry attachments, and only they are given more room.'
          : 'Attachments are sent base64-encoded, which adds a third to their size.'
      }`,
    );
  }

  if (path === SERVER_HEALTH_PATH) {
    const health: ServerHealthBody = {
      object: 'artemis.health',
      status: 'ok',
      version: context.version,
      api: SERVER_API_VERSION,
    };
    return ok(health);
  }

  const connection = resolveConnection(request.headers, context.connections);
  if (connection === undefined) {
    return {
      ...fail(
        401,
        'authentication_error',
        'invalid_api_key',
        'Send a connection token as `Authorization: Bearer <token>`. Settings → Server lists them, and each one carries its own working directory.',
      ),
      rejected: true,
    };
  }

  /*
   * Expiry is checked after the match and not folded into it.
   *
   * Folding it in would make an expired token indistinguishable from a wrong
   * one, which sounds safer and is worse in the only case that matters: the
   * holder of an expired token is the person who was given it, and telling
   * them "expired" instead of "invalid" is the difference between asking for a
   * new one and debugging a server they think is broken. It discloses nothing
   * a wrong guess could reach — the sentence is only ever shown to someone who
   * has already presented the real secret.
   *
   * It is also *checked here* rather than at connection-load time so that a
   * long-lived server does not go on honouring a token that expired while it
   * was running: `connections` is read fresh per request for the same reason.
   */
  if (connectionHasExpired(connection, Date.now())) {
    context.onRemoteAccess?.({ kind: 'remote.token.expired', connectionId: connection.id });
    return {
      ...fail(
        401,
        'authentication_error',
        'expired_api_key',
        'This connection has expired. Expiry is fixed when a token is issued and cannot be extended — create a new connection and revoke this one.',
      ),
      rejected: true,
      /*
       * No `connectionId`, deliberately — that field is what stamps
       * `lastUsedAt`. An expired token is one the user is deciding whether to
       * delete, and a stale poller hammering it would show "used just now"
       * forever, which is the opposite of what that column is for. The refusal
       * is still recorded, above, where it belongs.
       */
    };
  }

  const refresh = url.searchParams.get('refresh') === '1';
  const apiPrefix = `/api/${SERVER_API_VERSION}`;

  /**
   * The catalogue *this* connection can see.
   *
   * Filtered rather than merely enforced at call time, and that is the point of
   * doing it here: a connection restricted to one account should not be able to
   * *enumerate* the others, nor to see models on an account it may use but is
   * not allowed to run. A picker built against this token shows what it can
   * actually use, so a user of that program is never offered a route that will
   * come back refused.
   */
  const visibleProfiles = async (): Promise<readonly ServerProfile[]> =>
    visibleToConnection(connection, await context.catalogue.read({ refresh }));

  /** Every reply from here on is attributable to the connection that asked. */
  const answer = (body: unknown): ServerReply => ({ ...ok(body), connectionId: connection.id });

  /*
   * "Not built yet" is a different answer from "no such thing", and a client
   * deserves to be told which.
   *
   * This build serves the catalogue and nothing else, so every completions path
   * is absent — but absent for a reason a caller can act on. The first version
   * of this file checked the method before the path and answered `405 Method
   * Not Allowed` to `POST /v1/chat/completions`, which is precisely the wrong
   * thing to say: 405 means "this endpoint exists, you used the wrong verb",
   * and an OpenAI client shows that to a user who then goes looking for a GET.
   * Found by pointing the real SDK at it.
   *
   * 501 rather than 404, because the distinction is the whole point: the route
   * is one this server intends to have and does not have yet.
   */
  if (path === CHAT_COMPLETIONS_PATH) {
    if (method !== 'POST') {
      return fail(
        405,
        'invalid_request_error',
        'method_not_allowed',
        'Chat completions are a POST.',
      );
    }
    return handleChatCompletions(request, context, connection);
  }

  if (PLANNED_PATHS.has(path)) {
    return fail(
      501,
      'invalid_request_error',
      'not_implemented',
      `Artemis's server does not run turns yet — it publishes its catalogue only. ${path} is planned; list what is available at /v1/models.`,
    );
  }

  /*
   * The three verbs a *completions* client may address its own run with.
   * ==========================================================================
   *
   * `POST /api/v0/runs/{id}/{messages,permission,interrupt}`, and this block
   * sits above the remote bridge's dispatch deliberately. Read the precedence
   * rule before moving it.
   *
   * Two different clients address runs on this port, and they are not the same
   * kind of thing:
   *
   *  - The **bridge** (`remote.ts`) serves a window. It owns `/api/v0/runs`
   *    whole — the list, the `?after=` replay, and the five verbs `send`,
   *    `interrupt`, `respond-permission`, `stop-task`, `dispose` — and it
   *    authorises by what the connection's allowance can *see*.
   *  - The **completions surface** serves a provider adapter that holds a run
   *    id it was handed on its own stream. It gets three verbs and authorises
   *    by *ownership*: the run was started by this connection, through
   *    `/v1/chat/completions`, and is recorded in `runDirectory`.
   *
   * So the rule is ownership-gated precedence, one action at a time:
   *
   *  1. `messages` and `permission` are names the bridge does not have. They
   *     are answered here when this connection owns the run, and with a bare
   *     404 when it does not — the same sentence an id that never existed
   *     gets. They are never passed down, because the bridge would answer
   *     "no such run action" and a caller would have to tell two 404s apart.
   *  2. `interrupt` is a name **both** surfaces have. Ownership is asked
   *     *first*: an owned completions run is interrupted here, and everything
   *     else — every bridge-started run, every id this connection did not
   *     start — falls through untouched to `isRemotePath` below and is served
   *     exactly as it was before this block existed.
   *  3. Everything else under `/runs` is the bridge's and is not looked at
   *     here. In particular `GET /api/v0/runs` and
   *     `GET /api/v0/runs/{id}/events?after=N` have one owner, which is the
   *     bridge. A completions client is handed its run id on its own stream
   *     and does not enumerate; a second listing route, or a second replay
   *     route on a different query parameter, would be two answers to one
   *     question.
   *
   * The thing this shape exists to prevent is a prefix dispatcher. Claiming
   * `path.startsWith('/api/v0/runs')` here would swallow the bridge's entire
   * surface — the list, the stream replay, `send`, `respond-permission`,
   * `stop-task`, `dispose` — silently, with no conflict and no failing type,
   * because every one of those paths starts with those characters.
   */
  const owned = ownedCompletionsRunAction(context, connection, method, path);
  if (owned !== undefined) {
    const reply = await handleOwnedRunAction(context, connection, request, owned);
    return { ...reply, connectionId: connection.id };
  }

  /*
   * The remote bridge surface (ADR 0004): the run list, per-run replay and
   * control verbs, the terminals, and the event stream. Dispatched before the
   * read-only method gate below because several of its routes are POSTs, and
   * routed as one block because every one of them shares the same visibility
   * rule — what this connection's allowance can see — which lives in one
   * module rather than being re-derived per path. See `remote.ts`.
   */
  if (isRemotePath(path)) {
    return handleRemoteRequest({ request, context, connection, method, path, url });
  }

  /*
   * The account-administration surface, dispatched here for the same reason the
   * bridge above is: it writes, and one of its routes is a `DELETE` the
   * read-only gate below would refuse before the route was ever resolved.
   *
   * It sits *after* `isRemotePath` and is disjoint from it by construction. The
   * bridge owns `/runs`, `/events` and `/terminals`; this owns `/profiles/…`
   * and nothing else, so neither can shadow the other however this block is
   * reordered. That is a property worth stating out loud, because a dispatcher
   * that claimed a prefix the bridge already owned would swallow those routes
   * with nothing to show for it in a diff.
   *
   * `GET ${apiPrefix}/profiles` is deliberately *not* caught — that is the
   * catalogue read every client makes, it is authorised by the ordinary
   * allowance rather than by the administrative grant, and routing it through
   * here would hide the whole catalogue from every connection that is not an
   * administrator.
   */
  if (
    path === `${apiPrefix}/profiles` ? method === 'POST' : path.startsWith(`${apiPrefix}/profiles/`)
  ) {
    const reply = await handleProfileAdminRoute(request, context, connection, path, method);
    return { ...reply, connectionId: connection.id };
  }

  /*
   * Which of this machine's memory banks reaches which of its accounts.
   *
   * Dispatched beside the account surface above, under the same grant and with
   * the same enumeration-proof 404, because it is the same kind of act: a
   * token deciding what the accounts on somebody else's machine may see. It
   * owns `/memory-banks` and nothing else, so it cannot shadow the bridge or
   * the account routes however this block is reordered. Above the read-only
   * gate below because its write is a PATCH.
   */
  if (path === `${apiPrefix}/memory-banks` || path.startsWith(`${apiPrefix}/memory-banks/`)) {
    const reply = await handleMemoryBankRoute(request, context, connection, path, method);
    return { ...reply, connectionId: connection.id };
  }

  /*
   * The skills this machine carries. Owns `/skills` and everything under it.
   * Above the read-only gate because adding, pulling and removing a repository
   * are a POST and a DELETE; the handler gates those on the grant itself and
   * leaves the read open to any connection, which is `/commands`'s rule.
   */
  if (path === `${apiPrefix}/skills` || path.startsWith(`${apiPrefix}/skills/`)) {
    const reply = await handleSkillsRoute(request, context, connection, path, method, visibleProfiles);
    return { ...reply, connectionId: connection.id };
  }

  /*
   * The session mutations: rename, tag, delete.
   *
   * POST and DELETE, so they sit above the read-only gate below.
   * Authorisation is the messages route's, verbatim: the ledger scopes every
   * id to the connection that asks, and "not yours" answers exactly like
   * "not there" — a token must not be able to sound out which ids exist by
   * trying to rename them either.
   */
  if (path.startsWith(`${apiPrefix}/sessions/`) && (method === 'POST' || method === 'DELETE')) {
    if (context.ledger === undefined || context.sessions === undefined) {
      return fail(
        501,
        'invalid_request_error',
        'not_implemented',
        'This Artemis build serves its catalogue but keeps no session history.',
      );
    }
    const rest = path.slice(`${apiPrefix}/sessions/`.length);
    const action =
      method === 'DELETE' && !rest.includes('/')
        ? ('delete' as const)
        : method === 'POST' && rest.endsWith('/rename')
          ? ('rename' as const)
          : method === 'POST' && rest.endsWith('/tag')
            ? ('tag' as const)
            : null;
    if (action !== null) {
      const middle = action === 'delete' ? rest : rest.slice(0, -(`/${action}`.length));
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(middle);
      } catch {
        return fail(400, 'invalid_request_error', 'invalid_url', 'The session id could not be parsed.');
      }
      const profiles = await visibleProfiles();
      const scope = scopeFor(connection, profiles);
      if (sessionId.length === 0 || !context.ledger.mayAccess(scope, sessionId)) {
        return unknownSession();
      }
      const entry = context.ledger.get(sessionId);
      if (entry === undefined) return unknownSession();

      if (action === 'rename') {
        if (context.sessions.rename === undefined) {
          return fail(501, 'invalid_request_error', 'not_implemented', 'This server cannot rename stored sessions.');
        }
        const title =
          typeof request.body === 'object' && request.body !== null
            ? (request.body as { title?: unknown }).title
            : undefined;
        if (typeof title !== 'string' || title.trim().length === 0) {
          return fail(400, 'invalid_request_error', 'invalid_body', 'A rename needs a non-empty string "title".');
        }
        const stored = await context.sessions.rename({
          profileId: entry.profileId,
          sessionId,
          title,
          ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
        });
        const body: ServerSessionRenamedBody = { object: 'artemis.session.renamed', title: stored.title };
        return answer(body);
      }

      if (action === 'tag') {
        if (context.sessions.tag === undefined) {
          return fail(501, 'invalid_request_error', 'not_implemented', 'This server cannot tag stored sessions.');
        }
        const raw =
          typeof request.body === 'object' && request.body !== null
            ? (request.body as { tag?: unknown }).tag
            : undefined;
        if (raw !== null && typeof raw !== 'string') {
          return fail(400, 'invalid_request_error', 'invalid_body', 'A tag is a string, or null to clear it.');
        }
        const tagged = await context.sessions.tag({
          profileId: entry.profileId,
          sessionId,
          tag: raw,
          ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
        });
        const body: ServerSessionTaggedBody = { object: 'artemis.session.tagged', tagged };
        return answer(body);
      }

      if (context.sessions.delete === undefined) {
        return fail(501, 'invalid_request_error', 'not_implemented', 'This server cannot delete stored sessions.');
      }
      const deleted = await context.sessions.delete({
        profileId: entry.profileId,
        sessionId,
        ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
      });
      // The one session mutation that earns an access-log line: renames and
      // tags are cosmetic, a deletion is irreversible, and "which token
      // removed that conversation" is the question the record exists for.
      if (deleted) {
        context.onRemoteAccess?.({
          kind: 'remote.session.deleted',
          connectionId: connection.id,
          sessionId,
          profileId: entry.profileId,
        });
      }
      const body: ServerSessionDeletedBody = { object: 'artemis.session.deleted', deleted };
      return answer(body);
    }
  }

  /*
   * The routine surface: the whole of `/api/v0/routines`, dispatched here
   * because it writes (POST, PATCH, DELETE) and would otherwise be refused by
   * the read-only method gate below before its route was ever resolved. Its
   * own GET is answered here too rather than falling through, so one block owns
   * the scope rule the whole surface shares. Disjoint from every other
   * prefix — `/runs`, `/profiles`, `/sessions` — so nothing above can shadow it
   * and it can shadow nothing.
   */
  if (path === `${apiPrefix}/routines` || path.startsWith(`${apiPrefix}/routines/`)) {
    const reply = await handleRoutinesRequest(request, context, connection, method, path, visibleProfiles);
    return { ...reply, connectionId: connection.id };
  }

  if (method !== 'GET' && method !== 'HEAD') {
    // 405 only for a route that genuinely exists and genuinely refuses the
    // verb. Anything else is a 404, because "wrong method" on a path this
    // server has never heard of sends the caller looking for the right verb.
    return isServedPath(path)
      ? fail(
          405,
          'invalid_request_error',
          'method_not_allowed',
          `${method} is not supported on ${path}.`,
        )
      : fail(404, 'invalid_request_error', 'unknown_endpoint', `No route for ${path}.`);
  }

  if (path === '/') return answer(indexBody(context, connection));

  /**
   * Who am I, and where do my turns run?
   *
   * The call a client makes at startup to find out what it was handed. Without
   * it a program knows its token works and nothing else — not which directory
   * it is bound to, and not whether it may run turns at all.
   */
  if (path === `${apiPrefix}/connection`) return answer(describeConnection(connection));

  if (path === '/v1/models') {
    const profiles = await visibleProfiles();
    const list: OpenAiModelList = {
      object: 'list',
      data: routableModels(profiles).map((model) => ({
        id: model.route,
        object: 'model',
        // Seconds, not milliseconds. Every OpenAI client divides or formats
        // this, and a value a thousand times too large renders as the year
        // 56000 in the ones that format it.
        created: Math.floor(context.startedAt / 1000),
        owned_by: model.profileSlug,
      })),
    };
    return answer(list);
  }

  if (path.startsWith('/v1/models/')) {
    const profiles = await visibleProfiles();
    const model = findModel(profiles, path.slice('/v1/models/'.length));
    if (model === undefined) return modelNotFound(path.slice('/v1/models/'.length));
    return answer({
      id: model.route,
      object: 'model',
      created: Math.floor(context.startedAt / 1000),
      owned_by: model.profileSlug,
    });
  }

  if (path === `${apiPrefix}/profiles`) {
    const profiles = await visibleProfiles();
    const body: ServerProfilesBody = { object: 'artemis.profiles', profiles };
    return answer(body);
  }

  if (path === `${apiPrefix}/models`) {
    const profiles = await visibleProfiles();
    // A `?profile=` filter, because the flat list is the one a client polls and
    // an editor pinned to one account should not have to receive every other
    // account's catalogue to find its own rows. Matches slug or id, exactly as
    // a route's left half does.
    const wanted = url.searchParams.get('profile');
    const models = routableModels(profiles).filter(
      (model) =>
        wanted === null || model.profileSlug === wanted || String(model.profileId) === wanted,
    );
    const body: ServerModelsBody = { object: 'artemis.models', models };
    return answer(body);
  }

  /*
   * The session surface. Everything under it is scoped to the connection that
   * asks — see the ledger for the rule — and both routes answer through the
   * same gate, so "not yours" and "not there" are one indistinguishable 404.
   * A token must not be able to sound out which session ids exist.
   */
  /*
   * The gauges: one row per account this connection can see whose provider
   * reports plan capacity. What the profile menu reads for a local account,
   * served for the remote ones — same shape, same staleness rules, the
   * host's cache deciding what "fresh enough" means.
   */
  if (path === `${apiPrefix}/usage`) {
    if (context.usage === undefined) {
      return fail(
        501,
        'invalid_request_error',
        'not_implemented',
        'This Artemis build reads no plan gauges.',
      );
    }
    const profiles = await visibleProfiles();
    const rows = await context.usage.read({ profileIds: profiles.map((profile) => String(profile.id)) });
    const body: ServerUsageBody = { object: 'artemis.usage', accounts: rows as never };
    return answer(body);
  }

  /*
   * The slash commands a session here would offer, asked before there is one.
   *
   * What a remote composer's menu is filled from. The serving machine's own
   * skills and commands reach a served run through the same content bridge a
   * local run gets, so the names in this list are the names that machine
   * would honour — and a client holding the token learns them here rather
   * than keeping a copy of every skill on its own disk. One reading per
   * visible account, because a skill under one profile's directory reaches
   * that account alone; the union is what a menu wants before a route is
   * picked, and the per-account rows are what a person debugging a missing
   * skill wants. `?profile=<slug|id>` narrows to one account.
   */
  if (path === `${apiPrefix}/commands`) {
    if (context.commands === undefined) {
      return fail(
        501,
        'invalid_request_error',
        'not_implemented',
        'This Artemis build cannot enumerate slash commands.',
      );
    }
    const source = context.commands;
    const wanted = url.searchParams.get('profile');
    const profiles = (await visibleProfiles()).filter(
      (profile) => wanted === null || profile.slug === wanted || String(profile.id) === wanted,
    );
    if (wanted !== null && profiles.length === 0) {
      return fail(
        404,
        'invalid_request_error',
        'profile_not_found',
        `No account is served as "${wanted}". List them at ${apiPrefix}/profiles.`,
      );
    }
    // Where a turn on this connection would run, when that is a real
    // directory. A scratch workspace is made per session and there is no
    // session here, so the host picks somewhere that exists instead.
    const cwd = connection.workspace.kind === 'directory' ? connection.workspace.path : undefined;
    const accounts: readonly ServerCommandsAccount[] = await Promise.all(
      profiles.map(async (profile) => ({
        profileId: profile.id,
        profileSlug: profile.slug,
        profileLabel: profile.label,
        providerId: profile.provider.id,
        // The seam's contract is that it resolves; a host that breaks it
        // costs the reader one account's rows, not the whole menu.
        commands: await source
          .list({
            profileId: String(profile.id),
            providerId: profile.provider.id,
            ...(cwd === undefined ? {} : { cwd }),
          })
          .catch((): readonly string[] => []),
      })),
    );
    const body: ServerCommandsBody = {
      object: 'artemis.commands',
      commands: [...new Set(accounts.flatMap((account) => account.commands))],
      accounts,
    };
    return answer(body);
  }

  if (path === `${apiPrefix}/sessions`) {
    if (context.ledger === undefined || context.sessions === undefined) {
      return fail(
        501,
        'invalid_request_error',
        'not_implemented',
        'This Artemis build serves its catalogue but keeps no session history.',
      );
    }
    const profiles = await visibleProfiles();
    const scope = scopeFor(connection, profiles);
    const body: ServerSessionsBody = {
      object: 'artemis.sessions',
      sessions: await describeScopedSessions(context.sessions, context.ledger, scope, profiles),
    };
    return answer(body);
  }

  if (path.startsWith(`${apiPrefix}/sessions/`) && path.endsWith('/messages')) {
    if (context.ledger === undefined || context.sessions === undefined) {
      return fail(
        501,
        'invalid_request_error',
        'not_implemented',
        'This Artemis build serves its catalogue but keeps no session history.',
      );
    }
    const middle = path.slice(`${apiPrefix}/sessions/`.length, -'/messages'.length);
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(middle);
    } catch {
      return fail(400, 'invalid_request_error', 'invalid_url', 'The session id could not be parsed.');
    }
    const profiles = await visibleProfiles();
    const scope = scopeFor(connection, profiles);
    if (sessionId.length === 0 || !context.ledger.mayAccess(scope, sessionId)) {
      return unknownSession();
    }
    const entry = context.ledger.get(sessionId);
    if (entry === undefined) return unknownSession();
    /*
     * The page the client asked for. A window attaching to a run in progress
     * reads the turns *before* it as `limit: historyOffset` — see `RunHandle`
     * — and until these were read the route answered the whole file under
     * that ask, so the turn in progress was drawn once from the file and
     * again from the run. Anything but a whole number is refused outright
     * rather than read as "everything": a client that sent a limit meant one.
     */
    const limit = pageNumber(url.searchParams.get('limit'));
    const offset = pageNumber(url.searchParams.get('offset'));
    if (limit === 'invalid' || offset === 'invalid') {
      return fail(
        400,
        'invalid_request_error',
        'invalid_page',
        '`limit` and `offset` must be whole numbers.',
      );
    }
    const replay = await context.sessions.messages({
      profileId: entry.profileId,
      sessionId,
      // A stable synthetic id: these events are read, not fed to a live pane,
      // and the consumer re-stamps them into its own transcript anyway.
      runId: `server-replay:${sessionId}`,
      cwd: entry.cwd,
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
    });
    const body: ServerSessionMessagesBody = {
      object: 'artemis.session.messages',
      events: replay.events,
      hasMore: replay.hasMore,
    };
    return answer(body);
  }

  if (path.startsWith(`${apiPrefix}/models/`)) {
    const profiles = await visibleProfiles();
    const route = path.slice(`${apiPrefix}/models/`.length);
    const model = findModel(profiles, route);
    if (model === undefined) return modelNotFound(route);
    return answer(model);
  }

  return fail(404, 'invalid_request_error', 'unknown_endpoint', `No route for ${path}.`);
}

/**
 * A page number off the query string: absent, a whole number, or junk.
 *
 * Three answers rather than two because the route has to tell "no page asked
 * for" from "a page asked for badly". The first is the whole conversation, as
 * the route has always answered; the second is refused, because a client that
 * sent a limit meant one, and reading it as "everything" would hand back the
 * exact over-read the parameter exists to prevent.
 */
function pageNumber(raw: string | null): number | undefined | 'invalid' {
  if (raw === null) return undefined;
  return /^\d+$/.test(raw) ? Number(raw) : 'invalid';
}


/**
 * The index: what this server is and where the rest of it is.
 *
 * Present because the first thing anyone does with a new local server is open
 * its root in a browser, and a 404 there teaches them nothing. Every path it
 * names is one this build actually serves.
 *
 * It takes the *connection* as well as the context because one surface on it is
 * per-token rather than per-build. The account-administration routes answer
 * `404` to a connection without the grant, indistinguishably from a build that
 * has never had them — and an index that advertised them to every token would
 * hand back the one fact that posture exists to withhold: that this deployment
 * has an administrative surface, and therefore that some other token can add
 * accounts to it.
 */
function indexBody(context: ServerContext, connection: ServerConnection): Record<string, unknown> {
  const apiPrefix = `/api/${SERVER_API_VERSION}`;
  const managesProfiles = connection.manageProfiles === true && context.profileAdmin !== undefined;
  const managesBanks = connection.manageProfiles === true && context.memoryBanks !== undefined;
  return {
    object: 'artemis.server',
    version: context.version,
    api: SERVER_API_VERSION,
    endpoints: [
      { method: 'GET', path: SERVER_HEALTH_PATH, description: 'Liveness. The only path that needs no token.' },
      { method: 'GET', path: '/v1/models', description: 'Every route, in OpenAI shape.' },
      { method: 'GET', path: '/v1/models/{profile}/{model}', description: 'One route, in OpenAI shape.' },
      {
        method: 'GET',
        path: `${apiPrefix}/connection`,
        description: 'What your token is, and where its turns run.',
      },
      {
        method: 'GET',
        path: `${apiPrefix}/profiles`,
        description: 'Accounts, their capabilities, and the models each offers.',
      },
      {
        method: 'GET',
        path: `${apiPrefix}/models`,
        description:
          'Every route with thinking levels, fast mode and ultracode. Filter with ?profile=<slug>.',
      },
      {
        method: 'GET',
        path: `${apiPrefix}/models/{profile}/{model}`,
        description: 'One route, in full.',
      },
      // Named only when this build has the seam — the index's rule is that
      // every path on it actually answers.
      ...(context.commands === undefined
        ? []
        : [
            {
              method: 'GET',
              path: `${apiPrefix}/commands`,
              description:
                'The slash commands a session here would offer, the skills installed on this machine among them. Filter with ?profile=<slug>.',
            },
          ]),
      ...(context.skills === undefined
        ? []
        : [
            {
              method: 'GET',
              path: `${apiPrefix}/skills`,
              description:
                'The skills installed on this machine, what each is for, and the repositories it keeps cloned to get them.',
            },
            ...(connection.manageProfiles === true
              ? [
                  {
                    method: 'POST',
                    path: `${apiPrefix}/skills/sources`,
                    description: 'Clone a repository of skills onto this machine and keep it pulled.',
                  },
                  {
                    method: 'POST',
                    path: `${apiPrefix}/skills/sources/{id}/sync`,
                    description: 'Pull one repository now. POST /skills/sync pulls them all.',
                  },
                  {
                    method: 'DELETE',
                    path: `${apiPrefix}/skills/sources/{id}`,
                    description: 'Stop carrying a repository, and delete its clone.',
                  },
                ]
              : []),
          ]),
      // The remote bridge surface, named only when this build serves it —
      // the index's rule is that every path on it actually answers.
      ...(context.runs?.listRuns === undefined
        ? []
        : [
            {
              method: 'GET',
              path: `${apiPrefix}/runs`,
              description: 'Live runs visible to your connection.',
            },
          ]),
      ...(context.feed === undefined
        ? []
        : [
            {
              method: 'GET',
              path: `${apiPrefix}/events`,
              description:
                'The event stream (SSE). Resume with Last-Event-ID; gaps are reported, not hidden.',
            },
          ]),
      ...(managesProfiles
        ? [
            {
              method: 'POST',
              path: `${apiPrefix}/profiles`,
              description: 'Add an account. Needs a connection granted account administration.',
            },
            {
              method: 'POST',
              path: `${apiPrefix}/profiles/{id}/signin`,
              description:
                'Start the provider login for an account, and read back its verification URL.',
            },
            {
              method: 'POST',
              path: `${apiPrefix}/profiles/{id}/signin/code`,
              description: 'Hand the code the user pasted to the login that is waiting for it.',
            },
          ]
        : []),
      ...(managesBanks
        ? [
            {
              method: 'GET',
              path: `${apiPrefix}/memory-banks`,
              description:
                "This machine's memory banks, and the accounts each reaches, with the accounts to choose from.",
            },
            {
              method: 'PATCH',
              path: `${apiPrefix}/memory-banks/{slug}`,
              description: 'Choose which accounts one bank reaches, or all of them.',
            },
          ]
        : []),
    ],
    // Said out loud rather than left to a 401: a catalogue that changes when an
    // account is added is worth re-reading, and a client that does not know the
    // answer is cached will not know why its refresh did nothing.
    notes: [
      'Every path except /health requires `Authorization: Bearer <token>`.',
      'A model is addressed as `<profile>/<model>` — the account is part of the address.',
      'Where a turn runs is fixed to your connection, not chosen per request. See /api/v0/connection.',
      'Catalogues are cached for a few minutes. Append ?refresh=1 to force a re-read.',
      ...(managesProfiles
        ? [
            'This connection may add accounts and sign them in; a token without that grant gets a 404 for those routes.',
          ]
        : []),
    ],
  };
}

/** Every model on the server, in profile order. */
function routableModels(profiles: readonly ServerProfile[]): readonly ServerModel[] {
  return profiles.flatMap((profile) => profile.models);
}

/**
 * Resolve a route to a model.
 *
 * The path segment arrives percent-encoded in the general case — a client that
 * URL-encoded the slash is not wrong — so it is decoded before parsing.
 * Matching accepts the profile's slug *or* its id, which is what makes a route
 * survivable across a rename: see `parseModelRoute`.
 */
function findModel(
  profiles: readonly ServerProfile[],
  rawRoute: string,
): ServerModel | undefined {
  const parsed = parseModelRoute(decodeRoute(rawRoute));
  if (parsed === undefined) return undefined;

  for (const profile of profiles) {
    if (profile.slug !== parsed.profile && String(profile.id) !== parsed.profile) continue;
    for (const model of profile.models) {
      if (model.id === parsed.model) return model;
    }
  }
  return undefined;
}

/**
 * Undo the encoding a client may have applied to a route.
 *
 * A caller that percent-encoded the separator is not wrong, so `work-max%2Fopus`
 * has to resolve. A malformed escape is left as it arrived rather than throwing:
 * the caller asked for something that is not here either way, and a 400 about
 * URL syntax is a worse answer than "no such model".
 */
function decodeRoute(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The message quotes the route as the *caller meant it*, not as it arrived.
 *
 * Echoing the raw path put `work-max%2Fgpt-4` in front of a user who typed
 * `work-max/gpt-4` — the client shows this string verbatim, so an escape
 * sequence in it reads as part of the name they got wrong.
 */
function modelNotFound(route: string): ServerReply {
  return fail(
    404,
    'invalid_request_error',
    'model_not_found',
    `No model is routed at "${decodeRoute(route)}". List them at /v1/models.`,
  );
}

/**
 * Is this a path this build actually answers?
 *
 * Only used to tell a `405` from a `404` — the GET routing below is still the
 * one place a route is resolved, so this cannot drift into being a second
 * router. Kept in step with it by being the same four paths and two prefixes.
 *
 * The remote bridge and the account-administration surface are deliberately
 * *absent* from it, and for that second one the absence is a security property
 * rather than an oversight. Both dispatch above this gate and do their own
 * method checks, so neither can reach here; and if one ever did, a `405` on
 * `/api/v0/profiles/{id}/signin` would tell a token with no administrative
 * grant that the route exists — which is exactly the fact
 * `handleProfileAdminRoute`'s 404 is there to withhold. "Unlisted" is the safe
 * failure mode here and "listed" is not.
 */
function isServedPath(path: string): boolean {
  const apiPrefix = `/api/${SERVER_API_VERSION}`;
  return (
    path === '/' ||
    path === SERVER_HEALTH_PATH ||
    path === '/v1/models' ||
    path === `${apiPrefix}/profiles` ||
    path === `${apiPrefix}/models` ||
    path.startsWith('/v1/models/') ||
    path.startsWith(`${apiPrefix}/models/`)
  );
}

/** Strip a trailing slash so `/v1/models/` and `/v1/models` are one route. */
function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

function hostAllowed(
  host: string | undefined,
  allowed: readonly string[] | 'any' | undefined,
): boolean {
  if (allowed === 'any') return true;
  if (host === undefined) return false;
  // Strip the port. An IPv6 literal keeps its brackets, which is why they are
  // in `ALLOWED_HOSTS` — `[::1]:6472` splits to `[::1]`.
  const withoutPort = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : (host.split(':')[0] ?? '');
  const name = withoutPort.toLowerCase();
  if (ALLOWED_HOSTS.has(name)) return true;
  return allowed !== undefined && allowed.some((entry) => entry.toLowerCase() === name);
}

/**
 * Which connection does this request authenticate as, if any?
 *
 * Two headers are accepted for the reason {@link CORS_HEADERS} names one of
 * them: OpenAI-shaped clients send `Authorization: Bearer`, Anthropic-shaped
 * ones send `x-api-key`, and a router that only spoke one of those would turn
 * away half the ecosystem over a header name.
 *
 * **Every connection is compared, even after a match.** The loop does not break
 * early, because the time it takes to answer would otherwise reveal *which*
 * connection matched — and with it, roughly how many are configured and where in
 * the list a guessed prefix landed. The cost is a handful of fixed-time
 * comparisons on a list that is realistically single digits.
 */
function resolveConnection(
  headers: Readonly<Record<string, string | undefined>>,
  connections: readonly ServerConnection[],
): ServerConnection | undefined {
  const authorization = headers['authorization'];
  const presented =
    authorization !== undefined && /^bearer\s+/i.test(authorization)
      ? authorization.replace(/^bearer\s+/i, '').trim()
      : (headers['x-api-key']?.trim() ?? '');

  // An empty header must never match a connection whose token is somehow empty.
  if (presented.length === 0) return undefined;

  let matched: ServerConnection | undefined;
  for (const connection of connections) {
    if (connection.token.length === 0) continue;
    if (constantTimeEquals(presented, connection.token)) matched = connection;
  }
  return matched;
}

/**
 * Compare two secrets without leaking where they diverge.
 *
 * `timingSafeEqual` throws on a length mismatch — which is itself the leak it
 * is meant to prevent — so the lengths are compared first and the result is
 * folded in rather than returned early. The buffers are only compared when they
 * are the same size, and a wrong-length token costs the same as a wrong one.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still do a comparison, against a same-length buffer, so the reply time
    // does not depend on whether the length was right.
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

/* -------------------------------------------------------------------------- */
/* The socket                                                                 */
/* -------------------------------------------------------------------------- */

export interface ArtemisServerOptions {
  readonly port: number;
  /**
   * How to run a turn. Omit for a catalogue-only server, which answers `501`
   * on the completions path — see {@link ServerContext.runs}.
   */
  readonly runs?: RunSource;
  /** Where turns run. Required alongside {@link runs}. */
  readonly workspaces?: WorkspaceResolver;
  /**
   * The configured connections, read fresh on every request.
   *
   * A function rather than an array, and that is what makes revocation mean
   * something: a token deleted in the Server tab stops working on the *next*
   * request, with no restart. An array captured at construction would keep
   * authorising a connection the user believed they had just removed.
   */
  readonly connections: () => readonly ServerConnection[];
  readonly version: string;
  readonly catalogue: Catalogue;
  /** Defaults to {@link SERVER_HOST}. Injected only so a test can be explicit. */
  readonly host?: string;
  /** Session ownership, for the session surface and the resume gate. */
  readonly ledger?: SessionLedger;
  /** How to read stored sessions. Required alongside {@link ledger}. */
  readonly sessions?: SessionSource;
  /** Routines that fire in the server. Absent answers 501. See {@link ServerContext.routines}. */
  readonly routines?: ServerRoutineStore;
  /** How to read each account's plan gauge. Absent answers 501. */
  readonly usage?: UsageSource;
  /** How to enumerate an account's slash commands. Absent answers 501. */
  readonly commands?: CommandSource;
  /** See {@link ServerContext.allowedHosts}. */
  readonly allowedHosts?: readonly string[] | 'any';
  /** See {@link ServerContext.allowChromeBrowser}. */
  readonly allowChromeBrowser?: boolean;
  /** See {@link ServerContext.allowClientBrowser}. */
  readonly allowClientBrowser?: boolean;
  /** See {@link ServerContext.browserRelay}. */
  readonly browserRelay?: BrowserRelay;
  /** See {@link ServerContext.feed}. */
  readonly feed?: PushFeed;
  /** See {@link ServerContext.remoteStream}. */
  readonly remoteStream?: RemoteStreamOptions;
  /** See {@link ServerContext.guard}. */
  readonly guard?: RemoteRunGuard;
  /** See {@link ServerContext.terminals}. */
  readonly terminals?: RemoteTerminals;
  /** See {@link ServerContext.onRemoteAccess}. */
  readonly onRemoteAccess?: (event: RemoteAccessEvent) => void;
  /**
   * Ownership and the deadlines on detached completions runs.
   *
   * Built here from {@link runs} when it is not supplied, because the only
   * thing it needs is the engine and every deployment that can run a turn
   * wants one. Injected by a test that needs to control its clock, and by
   * nothing else. {@link ArtemisServer.close} closes whichever it ended up
   * with, so the subscription and the sweep do not outlive the port.
   */
  readonly runDirectory?: RunDirectory;
  /**
   * How to add a serving account. Omit for a deployment whose accounts are
   * managed some other way — the surface then answers `501` to an
   * administrator and `404` to everyone else.
   */
  readonly profileAdmin?: ProfileAdmin;
  /**
   * The sign-in director, built here from {@link signInTimeoutMs} when
   * {@link profileAdmin} is present and it is not supplied: every deployment
   * that can add an account wants one, and only a test needs to control its
   * clock or its subprocesses. {@link ArtemisServer.close} closes whichever it
   * ended up with, so a login subprocess cannot outlive the port.
   */
  readonly signIns?: SignInDirector;
  /** How long an unfinished sign-in lives. See `signin.ts`. */
  readonly signInTimeoutMs?: number;
  /**
   * This machine's memory-bank registry. Omit for a deployment that carries no
   * banks — the surface then answers `501` to an administrator and `404` to
   * everyone else, exactly as {@link profileAdmin} does.
   */
  readonly memoryBanks?: MemoryBankAdmin;
  /**
   * The skills this machine carries. Omit for a host that bridges none — the
   * surface then answers `501`. See {@link SkillsAdmin}.
   */
  readonly skills?: SkillsAdmin;
  /**
   * Called once per answered request, so the UI can show that something is
   * talking — and so the connection that asked can have its `lastUsedAt`
   * stamped. `connectionId` is absent when nothing authenticated.
   */
  readonly onRequest?: (outcome: {
    readonly rejected: boolean;
    readonly connectionId?: string;
  }) => void;
  /** Where a fault that never reached a client goes. */
  readonly onError?: (error: unknown) => void;
}

export interface ArtemisServer {
  /** Bind, and resolve the port actually bound — which differs from `port` when it was `0`. */
  listen(): Promise<number>;
  /** Stop accepting, and wait for open sockets to finish. */
  close(): Promise<void>;
}

/**
 * A listening Artemis server.
 *
 * Nothing here decides policy: every request goes straight to
 * {@link handleServerRequest} and the result is written out. What this layer
 * owns is the socket's own hazards — a listen that fails, a client that hangs
 * up mid-write, and a `close` that must not wait forever.
 */
export function createArtemisServer(options: ArtemisServerOptions): ArtemisServer {
  const host = options.host ?? SERVER_HOST;
  let startedAt = Date.now();

  const runs = options.runs;
  const runDirectory =
    runs === undefined
      ? undefined
      : (options.runDirectory ??
        createRunDirectory({
          runs,
          ...(options.onError === undefined ? {} : { onError: options.onError }),
        }));

  const profileAdmin = options.profileAdmin;
  const signIns =
    profileAdmin === undefined
      ? options.signIns
      : (options.signIns ??
        createSignInDirector(
          options.signInTimeoutMs === undefined ? {} : { timeoutMs: options.signInTimeoutMs },
        ));

  const server: Server = createServer((request, response) => {
    void answer(request, response);
  });

  async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    /*
     * The client going away is news the turn needs.
     *
     * A run started by this request is a real process on the user's machine
     * doing real work against their plan; if the caller has hung up, every
     * token after this point is spent on output nobody will read. The signal is
     * threaded into the router and reaches `runTurn`, which interrupts.
     */
    const disconnected = { aborted: false };
    request.on('aborted', () => {
      disconnected.aborted = true;
    });
    response.on('close', () => {
      if (!response.writableEnded) disconnected.aborted = true;
    });

    let reply: ServerReply | ServerStreamReply;
    try {
      reply = await handleServerRequest(
        {
          method: request.method ?? 'GET',
          url: request.url ?? '/',
          headers: request.headers as Readonly<Record<string, string | undefined>>,
          ...(await readJsonBody(request)),
          signal: disconnected,
        },
        {
          connections: options.connections(),
          version: options.version,
          catalogue: options.catalogue,
          startedAt,
          ...(runs === undefined ? {} : { runs }),
          ...(runDirectory === undefined ? {} : { runDirectory }),
          ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }),
          ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
          ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
          ...(options.routines === undefined ? {} : { routines: options.routines }),
          ...(options.usage === undefined ? {} : { usage: options.usage }),
          ...(options.commands === undefined ? {} : { commands: options.commands }),
          ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
          ...(options.allowChromeBrowser === true ? { allowChromeBrowser: true } : {}),
          // Grouped with Chrome because they are the same kind of thing, and
          // spelled differently because they default the other way: absent is
          // *on* here, so only an explicit `false` reaches the context.
          ...(options.allowClientBrowser === false ? { allowClientBrowser: false } : {}),
          ...(options.browserRelay === undefined ? {} : { browserRelay: options.browserRelay }),
          ...(options.feed === undefined ? {} : { feed: options.feed }),
          ...(options.remoteStream === undefined ? {} : { remoteStream: options.remoteStream }),
          ...(options.guard === undefined ? {} : { guard: options.guard }),
          connectionsNow: options.connections,
          ...(options.terminals === undefined ? {} : { terminals: options.terminals }),
          ...(options.onRemoteAccess === undefined
            ? {}
            : { onRemoteAccess: options.onRemoteAccess }),
          ...(profileAdmin === undefined ? {} : { profileAdmin }),
          ...(signIns === undefined ? {} : { signIns }),
          ...(options.memoryBanks === undefined ? {} : { memoryBanks: options.memoryBanks }),
          ...(options.skills === undefined ? {} : { skills: options.skills }),
          // Same sink as a transport fault: a host that wanted one stream of
          // things-that-went-wrong should not have to subscribe twice, and the
          // notice is already a sentence naming the route it belongs to.
          ...(options.onError === undefined ? {} : { onRunFailure: options.onError }),
        },
      );
    } catch (error) {
      options.onError?.(error);
      reply = {
        status: 500,
        headers: { ...JSON_HEADERS, ...CORS_HEADERS },
        // The message is fixed rather than the error's own: an exception's text
        // is written for a maintainer's log and can name a path, an account or
        // a command line, none of which belongs in a reply to a caller whose
        // identity is one token.
        body: { error: { message: 'The server failed to answer.', type: 'server_error' } },
      };
    }

    options.onRequest?.({
      rejected: isStreamReply(reply) ? false : reply.rejected === true,
      ...(reply.connectionId === undefined ? {} : { connectionId: reply.connectionId }),
    });

    // A client that hung up mid-request leaves nothing to write to, and
    // writing anyway throws asynchronously from a place with no caller.
    if (response.writableEnded || response.destroyed) return;

    if (isStreamReply(reply)) {
      response.writeHead(reply.status, { ...reply.headers });
      try {
        for await (const chunk of reply.stream) {
          if (response.writableEnded || response.destroyed) break;
          // Written and flushed one event at a time. Buffering here would turn
          // a stream into a slow whole-response, which is exactly what the
          // caller asked not to have.
          response.write(chunk);
        }
      } catch (error) {
        options.onError?.(error);
      }
      if (!response.writableEnded) response.end();
      return;
    }

    const payload = reply.body === null ? '' : `${JSON.stringify(reply.body)}\n`;
    const headers: Record<string, string> = { ...reply.headers };
    if (payload.length > 0) headers['content-length'] = String(Buffer.byteLength(payload));

    response.writeHead(reply.status, headers);
    // HEAD gets the headers and no body, which is the whole of what HEAD means
    // and what a client probing for liveness without cost expects.
    if (request.method?.toUpperCase() === 'HEAD' || payload.length === 0) {
      response.end();
      return;
    }
    response.end(payload);
  }

    /**
   * Read and parse a JSON body, for the routes that have one.
   *
   * Capped, because this is the one place a caller controls how much memory the
   * server allocates — an unbounded read is a one-line denial of service from
   * any process that has a token. A body that is not JSON is not an error here:
   * the router answers `400` with a message, which is a better failure than a
   * parse exception with no route context.
   */
  async function readJsonBody(
    request: IncomingMessage,
  ): Promise<{ body?: unknown; bodyOversize?: boolean }> {
    if (request.method !== 'POST' && request.method !== 'PATCH') return {};

    /*
     * Per route, because only the routes that carry attachments have a reason
     * to be large. `request.url` is a path here, read the same way the router
     * will read it; a path so malformed that `URL` will not have it gets the
     * narrow cap, and then the router's own `invalid_url`.
     */
    let cap = MAX_BODY_BYTES;
    try {
      cap = bodyCapFor(normalizePath(new URL(request.url ?? '/', 'http://localhost').pathname));
    } catch {
      // Left at the narrow cap.
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      // Reading stops here and the router answers; the rest of the upload is
      // abandoned, exactly as it was under the single flat cap. What changed is
      // only what the caller is told about it — see `bodyOversize`.
      if (size > cap) return { bodyOversize: true };
      chunks.push(buffer);
    }

    if (chunks.length === 0) return { body: undefined };
    try {
      return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } catch {
      return { body: undefined };
    }
  }

  server.on('clientError', (error, socket) => {
    options.onError?.(error);
    // A malformed request line never reaches the router, so the reply is
    // written by hand. Without this the socket is left open until it times out.
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return {
    listen() {
      return new Promise<number>((resolve, reject) => {
        const onError = (error: unknown): void => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.removeListener('error', onError);
          startedAt = Date.now();
          const address = server.address();
          resolve(typeof address === 'object' && address !== null ? address.port : options.port);
        };
        // `once` on both, and each removes the other: a server that fails to
        // bind emits `error` and never `listening`, and one that binds may emit
        // `error` later for an unrelated reason — which must not reject a
        // promise that has already resolved.
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(options.port, host);
      });
    },

    close() {
      // The directory holds an engine subscription and a timer. Neither is the
      // socket's business and both would outlive it — a server that had been
      // stopped would keep sweeping, and would eventually reap a run in an
      // engine the user has since gone back to using directly.
      runDirectory?.close();
      // A sign-in in flight is a *subprocess* parked on a person who can no
      // longer reach it, holding a config directory open. Stopping the server
      // is the last moment anything knows it exists.
      signIns?.close();
      return new Promise<void>((resolve) => {
        // `close` waits for open connections, and a client holding a keep-alive
        // socket would otherwise keep the port bound indefinitely — which the
        // user reads as "Stop did nothing". `closeAllConnections` is what makes
        // stopping immediate.
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Chat completions                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Run a turn, and answer with it — whole, or streamed.
 *
 * Every refusal happens before the run starts, and that ordering is the point:
 * an unsupported parameter, a route this connection may not use, a workspace
 * that has gone away. Once a run begins the user's plan is being spent, so
 * nothing that could have been caught first is allowed to be caught after.
 */
/** A connection's scope: its workspace identity, and the profiles it may see. */
function scopeFor(
  connection: ServerConnection,
  profiles: readonly ServerProfile[],
): LedgerScope {
  return {
    workspaceKey: workspaceKeyFor(connection),
    profileIds: profiles.map((profile) => String(profile.id)),
  };
}

/** One refusal for "absent" and "not yours" alike. See the routes' comment. */
function unknownSession(): ServerReply {
  return fail(
    404,
    'invalid_request_error',
    'unknown_session',
    'No such conversation for this connection.',
  );
}

/* -------------------------------------------------------------------------- */
/* The routine surface                                                        */
/* -------------------------------------------------------------------------- */

/** The routine equivalent of {@link unknownSession}: "not yours" reads as "not there". */
function unknownRoutine(): ServerReply {
  return fail(404, 'invalid_request_error', 'unknown_routine', 'No such routine for this connection.');
}

/** A string field a routine draft may carry, or `undefined` when absent. Wrong
 * types and over-length strings are dropped — the store is the final gate on a
 * routine's usability, and this only has to keep a client bug from becoming a
 * type error. */
function wireString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

/** Read a routine draft off the wire. `cwd`, `scope` and `connectionId` are the
 * server's to decide, so a draft that names them is read as if it had not. */
function readWireRoutineDraft(value: unknown): { readonly value: RoutineDraft } | { readonly error: string } {
  if (typeof value !== 'object' || value === null) {
    return { error: 'The request body must be a JSON object.' };
  }
  const draft = (value as { draft?: unknown }).draft;
  if (typeof draft !== 'object' || draft === null) {
    return { error: '`draft` must be an object.' };
  }
  const record = draft as Record<string, unknown>;
  const name = record['name'];
  const instructions = record['instructions'];
  const profileId = record['profileId'];
  const providerId = record['providerId'];
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) {
    return { error: '`draft.name` must be a non-empty string of at most 200 characters.' };
  }
  if (typeof instructions !== 'string' || instructions.trim().length === 0 || instructions.length > 20_000) {
    return { error: '`draft.instructions` must be a non-empty string of at most 20000 characters.' };
  }
  if (typeof profileId !== 'string' || profileId.length === 0) {
    return { error: '`draft.profileId` names the account each firing bills.' };
  }
  if (typeof providerId !== 'string' || providerId.length === 0) {
    return { error: '`draft.providerId` is required.' };
  }
  if (typeof record['schedule'] !== 'object' || record['schedule'] === null) {
    return { error: '`draft.schedule` is required.' };
  }
  const model = wireString(record['model'], 200);
  const effort = wireString(record['effort'], 100);
  const permissionMode = wireString(record['permissionMode'], 40);
  return {
    value: {
      name: name.trim(),
      instructions,
      profileId,
      providerId: providerId as ProviderId,
      schedule: record['schedule'] as RoutineDraft['schedule'],
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(permissionMode === undefined
        ? {}
        : { permissionMode: permissionMode as RoutineDraft['permissionMode'] }),
      ...(typeof record['paused'] === 'boolean' ? { paused: record['paused'] } : {}),
    },
  };
}

/** Read a routine edit off the wire. Only the fields a server routine will
 * actually change are read; the rest are the routine's fixed identity. */
function readWireRoutinePatch(value: unknown): { readonly value: RoutinePatch } | { readonly error: string } {
  if (typeof value !== 'object' || value === null) {
    return { error: 'The request body must be a JSON object.' };
  }
  const patch = (value as { patch?: unknown }).patch;
  if (typeof patch !== 'object' || patch === null) {
    return { error: '`patch` must be an object.' };
  }
  const record = patch as Record<string, unknown>;
  const built: {
    -readonly [K in keyof RoutinePatch]: RoutinePatch[K];
  } = {};
  const name = wireString(record['name'], 200);
  if (name !== undefined) built.name = name;
  if (typeof record['instructions'] === 'string' && record['instructions'].length <= 20_000) {
    built.instructions = record['instructions'];
  }
  // Empty clears, exactly as the store's own merge reads it.
  if (typeof record['model'] === 'string' && record['model'].length <= 200) built.model = record['model'];
  if (typeof record['effort'] === 'string' && record['effort'].length <= 100) built.effort = record['effort'];
  const permissionMode = wireString(record['permissionMode'], 40);
  if (permissionMode !== undefined) {
    built.permissionMode = permissionMode as RoutinePatch['permissionMode'];
  }
  if (typeof record['schedule'] === 'object' && record['schedule'] !== null) {
    built.schedule = record['schedule'] as RoutinePatch['schedule'];
  }
  if (typeof record['paused'] === 'boolean') built.paused = record['paused'];
  return { value: built };
}

/**
 * The whole of `/api/v0/routines`, scoped by the connection's workspace key.
 *
 * The scope rule is the session surface's, applied to a different noun: a token
 * touches exactly the routines whose `scope` matches its own pin, create stamps
 * that pin, and every "not yours" answers like "not there". The store is the
 * one that enforces it — this resolves the scope and the id and hands them
 * over.
 */
async function handleRoutinesRequest(
  request: ServerRequestInfo,
  context: ServerContext,
  connection: ServerConnection,
  method: string,
  path: string,
  visibleProfiles: () => Promise<readonly ServerProfile[]>,
): Promise<ServerReply> {
  const apiPrefix = `/api/${SERVER_API_VERSION}`;
  const store = context.routines;
  if (store === undefined) {
    return fail(
      501,
      'invalid_request_error',
      'not_implemented',
      'This Artemis build serves its catalogue but keeps no server-side routines.',
    );
  }
  const scope = workspaceKeyFor(connection);

  if (path === `${apiPrefix}/routines`) {
    if (method === 'GET') {
      const body: ServerRoutinesBody = { object: 'artemis.routines', routines: store.listFor(scope) };
      return ok(body);
    }
    if (method === 'POST') {
      const draft = readWireRoutineDraft(request.body);
      if ('error' in draft) {
        return fail(400, 'invalid_request_error', 'invalid_body', draft.error);
      }
      // The account each firing bills must be one this connection can see —
      // otherwise a token could schedule work on an account it may not run,
      // and enumerate the hidden ones by which ids are accepted.
      const profiles = await visibleProfiles();
      if (!profiles.some((profile) => String(profile.id) === draft.value.profileId)) {
        return fail(404, 'invalid_request_error', 'unknown_profile', 'No such account for this connection.');
      }
      try {
        const routine = await store.create({ draft: draft.value, connection });
        const body: ServerRoutineBody = { object: 'artemis.routine', routine };
        return ok(body);
      } catch (error) {
        return fail(
          400,
          'invalid_request_error',
          'invalid_body',
          error instanceof Error ? error.message : 'The routine could not be created.',
        );
      }
    }
    return fail(405, 'invalid_request_error', 'method_not_allowed', `${method} is not supported on ${path}.`);
  }

  const rest = path.slice(`${apiPrefix}/routines/`.length);
  const isRunNow = method === 'POST' && rest.endsWith('/run-now');
  const idText = isRunNow ? rest.slice(0, -'/run-now'.length) : rest;
  // Anything with a further slash is a sub-route this surface does not have.
  if (idText.length === 0 || idText.includes('/')) return unknownRoutine();
  let id: string;
  try {
    id = decodeURIComponent(idText);
  } catch {
    return fail(400, 'invalid_request_error', 'invalid_url', 'The routine id could not be parsed.');
  }
  if (id.length === 0) return unknownRoutine();

  if (isRunNow) {
    const routine = await store.runNow(scope, id);
    if (routine === undefined) return unknownRoutine();
    const body: ServerRoutineBody = { object: 'artemis.routine', routine };
    return ok(body);
  }

  if (method === 'PATCH') {
    const patch = readWireRoutinePatch(request.body);
    if ('error' in patch) {
      return fail(400, 'invalid_request_error', 'invalid_body', patch.error);
    }
    const routine = await store.update(scope, id, patch.value);
    if (routine === undefined) return unknownRoutine();
    const body: ServerRoutineBody = { object: 'artemis.routine', routine };
    return ok(body);
  }

  if (method === 'DELETE') {
    const removed = await store.remove(scope, id);
    if (!removed) return unknownRoutine();
    const body: ServerRoutineDeletedBody = { object: 'artemis.routine.deleted', deleted: true };
    return ok(body);
  }

  return fail(405, 'invalid_request_error', 'method_not_allowed', `${method} is not supported on ${path}.`);
}

/* -------------------------------------------------------------------------- */
/* The completions surface's own run verbs                                    */
/* -------------------------------------------------------------------------- */

/**
 * The three verbs, and only these three.
 *
 * `messages` and `permission` are this surface's alone. `interrupt` is shared
 * with the bridge by name and separated by ownership — see the dispatch
 * comment. Nothing here is a prefix: an action not on this list is not this
 * module's, whatever it is called.
 */
const OWNED_RUN_ACTIONS = new Set(['messages', 'permission', 'interrupt']);

/**
 * The one `GET` on an owned run: `GET /api/v0/runs/{id}/stream?after=N`, the
 * completions stream picked back up. A verb of this surface and not the
 * bridge's, because what it replays is the *completions* translation of the
 * run — OpenAI-shaped chunks — which only this surface speaks; the bridge's
 * `events` replay hands back raw engine events to a window.
 */
const OWNED_RUN_STREAM = 'stream';

/** One completions run, and what its own client asked of it. */
interface OwnedRunAction {
  readonly runId: RunId;
  readonly action: 'messages' | 'permission' | 'interrupt' | 'stream';
  /**
   * The connection owns this run. False only for `messages` and `permission`,
   * which are refused rather than passed on; an unowned `interrupt` never
   * reaches here at all, because it belongs to the bridge.
   */
  readonly owned: boolean;
}

/**
 * Is this request one of the three verbs, aimed at a run this connection owns?
 *
 * Returns `undefined` for everything else, which is the signal to leave the
 * path alone and let the bridge's dispatch have it. The asymmetry between the
 * two outcomes is the whole point:
 *
 *  - An **unowned `interrupt`** returns `undefined`, so the bridge answers it
 *    exactly as it did before this surface existed. A bridge-started run must
 *    not become uninterruptible because a second registry does not know it.
 *  - An **unowned `messages` or `permission`** returns a record with
 *    `owned: false`, so the caller gets one flat 404 here rather than the
 *    bridge's "no such run action". Those two names mean something on this
 *    server, and which of them a token may use is an ownership fact — not one
 *    a refusal should spell differently depending on whether the run exists.
 */
function ownedCompletionsRunAction(
  context: ServerContext,
  connection: ServerConnection,
  method: string,
  path: string,
): OwnedRunAction | undefined {
  if (method !== 'POST' && method !== 'GET') return undefined;
  const prefix = `/api/${SERVER_API_VERSION}/runs/`;
  if (!path.startsWith(prefix)) return undefined;

  const rest = path.slice(prefix.length);
  const separator = rest.indexOf('/');
  if (separator <= 0) return undefined;
  const action = rest.slice(separator + 1);
  // `stream` is the only GET here; every other GET under `/runs` is the
  // bridge's, and every POST here is one of the three verbs.
  if (method === 'GET' ? action !== OWNED_RUN_STREAM : !OWNED_RUN_ACTIONS.has(action)) {
    return undefined;
  }

  let runId: string;
  try {
    runId = decodeURIComponent(rest.slice(0, separator));
  } catch {
    // The id it literally was, matching `parseRemoteResourcePath`: the caller
    // asked about something that is not there either way, and a 400 about URL
    // syntax is a worse answer than "no such run".
    runId = rest.slice(0, separator);
  }
  if (runId.length === 0) return undefined;

  const owned = context.runDirectory?.owns(connection.id, runId) === true;
  if (!owned && action === 'interrupt') return undefined;
  return { runId, action: action as OwnedRunAction['action'], owned };
}

/**
 * Claim a run nobody owns for the connection whose conversation it is in.
 *
 * A run the provider started on its own — the turn it takes when a subagent
 * settles — has no connection behind it, and until now no client could reach
 * its stream: the route answered 404, the pane read idle, and the first thing
 * that put the turn on screen was a message typed into it, which
 * `steerLiveRun` claims on exactly these terms. The terms: the run is live,
 * it names a session, and the caller's scope may access that session — which
 * is what the resume gate checks before a completions request may continue
 * it. Idempotent, and never for a run another connection holds: `claim`
 * keeps the first owner, and the answer is read back rather than assumed.
 *
 * False for everything else, including a build with no ledger: a run without
 * a conversation to be owned through stays exactly as unreachable as before.
 */
async function claimSessionRun(
  context: ServerContext,
  connection: ServerConnection,
  runId: RunId,
): Promise<boolean> {
  const getRun = context.runs?.getRun;
  const directory = context.runDirectory;
  const ledger = context.ledger;
  if (getRun === undefined || directory === undefined || ledger === undefined) return false;

  let handle: RunHandle | undefined;
  try {
    handle = await getRun(runId);
  } catch {
    return false;
  }
  if (handle === undefined || handle.status === 'ended' || handle.sessionId === undefined) {
    return false;
  }
  const profiles = visibleToConnection(connection, await context.catalogue.read({}));
  if (!ledger.mayAccess(scopeFor(connection, profiles), String(handle.sessionId))) return false;

  directory.claim({ runId, connectionId: connection.id, permissions: true });
  return directory.owns(connection.id, runId);
}

/**
 * Steer, approve, or stop a run this connection started over completions.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE
 * ---------------------------------------------------------------------------
 *
 * **A run belongs to the connection that started it.** Not to the token that
 * knows its id — ids travel, in logs and screenshots and error reports — and
 * not to any token pinned to the same directory. Ownership is resolved before
 * anything else happens, and a failure is the same 404 as an id that never
 * existed. That check is the whole authorisation model of this surface, so it
 * lives in one place (`ownedCompletionsRunAction`) and no route here is
 * permitted its own version of it.
 */
async function handleOwnedRunAction(
  context: ServerContext,
  connection: ServerConnection,
  request: ServerRequestInfo,
  route: OwnedRunAction,
): Promise<ServerReply | ServerStreamReply> {
  if (!route.owned && !(await claimSessionRun(context, connection, route.runId))) {
    return unknownRun();
  }

  const runs = context.runs;
  const directory = context.runDirectory;
  if (runs === undefined || directory === undefined) {
    // Unreachable while the run is owned — nothing can own a run without a
    // directory — but written as a refusal rather than an assertion, because a
    // router that threw here would take out the socket.
    return unknownRun();
  }

  // Somebody is here. Whatever they came for, the run is not abandoned — see
  // `noteSeen`, and the detached-run deadline it holds off.
  directory.noteSeen(route.runId);

  /*
   * Attributed exactly as the bridge attributes its own verbs, and written
   * before the verb runs for the same reason: the acts most worth a name
   * against them — an interrupt, an `allow` on a prompt — are the ones that can
   * be followed by a crash. Ids only; the record has nowhere for a message or a
   * decision's arguments to go.
   */
  const record = (): void => {
    context.onRemoteAccess?.({
      kind: route.action === 'permission' ? 'remote.permission.answered' : 'remote.run.acted',
      connectionId: connection.id,
      action: route.action,
      runId: route.runId,
    });
  };

  if (route.action === 'interrupt') {
    record();
    return interruptOwnedRun(runs, route.runId);
  }
  if (route.action === 'stream') {
    record();
    return streamOwnedRun(context, runs, directory, connection, request, route.runId);
  }
  if (route.action === 'messages') {
    return sendToOwnedRun(runs, route.runId, request.body, record);
  }
  return answerOwnedPermission(runs, directory, route.runId, request.body, record);
}

/**
 * Pick an owned run's completions stream back up.
 *
 * The client lost its socket with the run still going — `artemis.remote.detach`
 * kept it — and is back with the last cursor it rendered. What it gets is the
 * same stream it would have had: every chunk after that cursor, translated
 * exactly as the original request translated them, then the live tail until
 * the run ends. See `resumeTurn` for what is replayed and what is not.
 *
 * Attaching is recorded on the directory as the opposite of detaching: the
 * run's own deadline stops and its parked prompts' deadline starts, because
 * somebody is in front of them again. When this stream goes too, the run is
 * handed back to the directory as it was the first time.
 */
function streamOwnedRun(
  context: ServerContext,
  runs: RunSource,
  directory: RunDirectory,
  connection: ServerConnection,
  request: ServerRequestInfo,
  runId: RunId,
): ServerReply | ServerStreamReply {
  const url = new URL(request.url, 'http://artemis.invalid');
  const rawAfter = url.searchParams.get('after');
  let afterSeq: number | undefined;
  if (rawAfter !== null) {
    if (!/^\d+$/.test(rawAfter)) {
      return fail(400, 'invalid_request_error', 'invalid_after', '`after` must be a whole number.');
    }
    afterSeq = Number(rawAfter);
  }

  directory.noteAttached(runId);

  const resume: ResumeRequest = {
    runId,
    ...(afterSeq === undefined ? {} : { afterSeq }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    onDetach: (id: RunId) => directory.noteDetached(id),
  };
  return {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
    connectionId: connection.id,
    stream: streamResume({
      id: `chatcmpl-${Math.random().toString(36).slice(2, 12)}`,
      created: Math.floor(Date.now() / 1000),
      route: directory.routeOf(runId) ?? 'artemis',
      runs,
      request: resume,
      heartbeatMs: context.remoteStream?.heartbeatMs ?? DEFAULT_COMPLETIONS_HEARTBEAT_MS,
    }),
  };
}

/**
 * The same refusal, for runs.
 *
 * A run id is a uuid the server minted, so guessing one is not the threat —
 * *confirming* one is. A reply that distinguished "no such run" from "not your
 * run" would let a token with any run id in hand learn that it names something
 * real on this server, and from there which of a set of ids belong to the
 * connection next door. One sentence for both, exactly as the session routes
 * do it.
 */
function unknownRun(): ServerReply {
  return fail(404, 'invalid_request_error', 'unknown_run', 'No such run for this connection.');
}

/**
 * An attachment this server will not take, as a reply.
 *
 * `AttachmentError` already carries the field and the reason, and both are
 * safe to repeat: every string in it was written here, about a value the caller
 * sent. Anything else caught where one of these was expected is a fault in the
 * reader rather than a fact about the request, so it becomes a 500 with nothing
 * in it — the same discipline `runFailure` keeps one function below.
 */
function attachmentFailure(error: unknown): ServerReply {
  return error instanceof AttachmentError
    ? fail(400, 'invalid_request_error', 'invalid_body', error.message)
    : fail(500, 'server_error', 'internal_error', 'The attachments could not be read.');
}

/**
 * Name the kind of attachment an account cannot carry, if any.
 *
 * Per kind rather than as one flag, because the two travel by different
 * mechanisms and a provider can plausibly have one and not the other — an image
 * needs a place on the wire, a file needs the adapter to stage it and say
 * where. The registry behind the run applies exactly this test again; doing it
 * here is what turns "the run failed" into a 400 that names the account.
 *
 * An account whose capabilities this build could not read answers `undefined`
 * — unknown is not a refusal, and the registry is still there.
 */
function unsupportedAttachment(
  attachments: readonly Attachment[] | undefined,
  capabilities: Capabilities | undefined,
): 'images' | 'files' | undefined {
  if (attachments === undefined || attachments.length === 0) return undefined;
  if (capabilities === undefined) return undefined;
  if (!capabilities.imageInput && attachments.some(isImageAttachment)) return 'images';
  if (!capabilities.fileInput && attachments.some(isFileAttachment)) return 'files';
  return undefined;
}

/**
 * A run that would not do what it was asked.
 *
 * `RunError`'s message is passed through and nothing else's is. The caller has
 * already been proven to own this run, so "already ended" or "this provider
 * cannot steer mid-turn" is a fact about their own conversation and is the
 * whole of what they need to recover. An error from anywhere else is an
 * unbounded string from an adapter — it can name a path, a command line or an
 * account — and none of that belongs in a reply to a bearer token.
 */
function runFailure(error: unknown): ServerReply {
  return error instanceof RunError
    ? fail(409, 'invalid_request_error', 'run_unavailable', error.message)
    : fail(502, 'server_error', 'run_failed', 'The run could not be reached.');
}

/**
 * Another message into a run that is already going.
 *
 * Attachments used to be deliberately dropped here, on the reasoning that
 * nothing on this boundary validated a base64 blob and an unchecked one would
 * travel from a bearer token straight into an adapter's argument encoder. That
 * was the right call for as long as it was true. `readAttachments` is now that
 * validator — the same one the IPC boundary and the bridge's own start route
 * use, stated once in protocol — so the reason has gone and the drop with it.
 *
 * The drop was never cheap. A steer is how a person mid-conversation says "here
 * is the screenshot I meant", and the text arriving alone made the agent answer
 * about a picture it had not been given.
 */
async function sendToOwnedRun(
  runs: RunSource,
  runId: RunId,
  body: unknown,
  record: () => void,
): Promise<ServerReply> {
  // The host may serve completions and decline steering. Answered before the
  // body is read, so a build without it says so rather than validating input it
  // has no use for.
  if (runs.send === undefined) return notSteerable();
  if (typeof body !== 'object' || body === null) {
    return fail(400, 'invalid_request_error', 'invalid_body', 'The request body must be a JSON object.');
  }
  const text = (body as { text?: unknown }).text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return fail(400, 'invalid_request_error', 'invalid_body', '`text` must be a non-empty string.');
  }
  let attachments: readonly Attachment[] | undefined;
  try {
    attachments = readAttachments((body as { attachments?: unknown }).attachments, 'attachments');
  } catch (error) {
    return attachmentFailure(error);
  }

  try {
    record();
    const outcome = await runs.send(runId, text, attachments);
    const reply: RunsSendResponse = {
      runId,
      deliveredImmediately: outcome.deliveredImmediately,
    };
    return ok(reply);
  } catch (error) {
    return runFailure(error);
  }
}

/** The answer on a host that runs turns but exposes no way to steer one. */
function notSteerable(): ServerReply {
  return fail(
    501,
    'invalid_request_error',
    'not_implemented',
    'This Artemis build runs turns but cannot take another message into one that is already going.',
  );
}

/**
 * Stop a run.
 *
 * The counterweight to detaching, and the reason detaching is safe to offer: a
 * disconnect stops meaning "stop", so there has to be something that still
 * does.
 */
async function interruptOwnedRun(runs: RunSource, runId: RunId): Promise<ServerReply> {
  try {
    await runs.interrupt(runId);
    const body: RunsInterruptResponse = { runId };
    return ok(body);
  } catch (error) {
    return runFailure(error);
  }
}

/**
 * Answer a prompt the run is parked on.
 *
 * A separate request from the stream that asked, because by the time the answer
 * comes the asking stream is routinely gone — that is the entire scenario this
 * exists for. The decision is re-read from scratch rather than trusted: see
 * `reviewPermissionDecision` for the escalations a `PermissionDecision` can
 * express and why none of them is reachable from *this* surface.
 *
 * The narrowing is this surface's alone. The bridge's `respond-permission`
 * keeps the full `PermissionDecision`, and the difference is not an
 * inconsistency: the bridge's caller is the user, in their own window, and a
 * mode change or a durable "always allow" is theirs to make. A completions
 * caller is a *program borrowing an account* — the same principal that may not
 * choose a permission mode when it starts a run — so it may approve the call in
 * front of it and nothing wider.
 */
async function answerOwnedPermission(
  runs: RunSource,
  directory: RunDirectory,
  runId: RunId,
  body: unknown,
  record: () => void,
): Promise<ServerReply> {
  if (typeof body !== 'object' || body === null) {
    return fail(400, 'invalid_request_error', 'invalid_body', 'The request body must be a JSON object.');
  }
  const requestId = (body as { requestId?: unknown }).requestId;
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return fail(
      400,
      'invalid_request_error',
      'invalid_body',
      '`requestId` must name the prompt being answered.',
    );
  }

  const review = reviewPermissionDecision((body as { decision?: unknown }).decision);
  if ('error' in review) {
    return fail(400, 'invalid_request_error', review.code, review.error);
  }

  try {
    record();
    await runs.respondToPermission(runId, requestId, review.decision);
  } catch (error) {
    return runFailure(error);
  }
  directory.noteAnswered(runId, requestId);

  const reply: RunsRespondPermissionResponse = { requestId };
  return ok(reply);
}

/* -------------------------------------------------------------------------- */
/* Accounts: adding one, and signing it in                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything under `/api/v0/profiles` that is not the catalogue read.
 *
 * ---------------------------------------------------------------------------
 * WHY A CONNECTION WITHOUT THE GRANT GETS A 404 AND NOT A 403
 * ---------------------------------------------------------------------------
 *
 * The same rule the run and session surfaces keep, for the same reason: a
 * refusal that distinguished "you may not" from "there is nothing here" tells a
 * token something about the server it was not given. Here what it would tell it
 * is the most useful thing an attacker could learn — that this deployment has
 * an administrative surface at all, and therefore that some *other* token can
 * add accounts to it. So a connection without {@link ServerConnection.manageProfiles}
 * gets the answer it would get from a build that has never heard of these
 * routes, and it gets it before anything else is read.
 *
 * The order matters and is not decorative. The grant is checked first, then the
 * seam, then the body: a build with no `profileAdmin` answers `501` to an
 * administrator and `404` to everyone else, so the 501 itself is not a fact an
 * unprivileged token can collect.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ATTRIBUTED, AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 *
 * Every act here goes through {@link ServerContext.onRemoteAccess}, the same
 * record the bridge's run and terminal verbs write to — these are the acts on
 * this server that most deserve a name against them, because they create a
 * credential on the serving machine that every later run may spend. Reads are
 * not recorded, exactly as they are not on the bridge: polling a sign-in is how
 * a client draws a frame, and a line per poll would bury the four lines a year
 * that matter.
 *
 * Nothing on those lines is a secret and nothing can become one. The record's
 * allowlist (`RECORDED_KEYS` in `sessions/lifecycleLog.ts`) has no field the
 * verification URL or the pasted code could travel in, and the ids that *are*
 * written are checked against the server's own state first — see `knownFlow`
 * below — so a caller cannot write an arbitrary string into the log by naming
 * an account that does not exist.
 */
async function handleProfileAdminRoute(
  request: ServerRequestInfo,
  context: ServerContext,
  connection: ServerConnection,
  path: string,
  method: string,
): Promise<ServerReply | ServerStreamReply> {
  const missing = (): ServerReply =>
    fail(404, 'invalid_request_error', 'unknown_endpoint', `No route for ${path}.`);

  if (connection.manageProfiles !== true) return missing();

  const admin = context.profileAdmin;
  const signIns = context.signIns;
  if (admin === undefined || signIns === undefined) {
    return fail(
      501,
      'invalid_request_error',
      'not_implemented',
      'This Artemis build serves accounts but cannot add or sign them in. Use the server CLI: `artemis-server profile add`.',
    );
  }

  const apiPrefix = `/api/${SERVER_API_VERSION}`;
  if (path === `${apiPrefix}/profiles`) {
    return createProfileRoute(admin, request.body, (created) => {
      /*
       * Recorded *after* the account exists, which is the one place on this
       * surface that departs from the bridge's "write the line before the verb
       * runs" rule — and it departs because the id the line is about does not
       * exist until the store has minted it. A line naming the label instead
       * would be a line naming user text, which this record does not carry.
       */
      context.onRemoteAccess?.({
        kind: 'remote.profile.created',
        connectionId: connection.id,
        profileId: String(created.id),
        providerId: created.providerId,
      });
    });
  }

  const rest = path.slice(`${apiPrefix}/profiles/`.length);
  const separator = rest.indexOf('/');
  const action = separator < 0 ? '' : rest.slice(separator + 1);
  // Enumerated, so an unknown sub-path 404s before an id is even decoded. The
  // oauth prefix is the one open-ended member: everything under it is a path
  // on the login's own loopback server, relayed below.
  const oauthRelay = action === 'signin/oauth' || action.startsWith('signin/oauth/');
  if (action !== '' && action !== 'signin' && action !== 'signin/code' && !oauthRelay) {
    return missing();
  }

  let profileId: string;
  try {
    profileId = decodeURIComponent(separator < 0 ? rest : rest.slice(0, separator));
  } catch {
    return fail(400, 'invalid_request_error', 'invalid_url', 'The account id could not be parsed.');
  }
  if (profileId.length === 0) return missing();

  /*
   * The login's own web pages, relayed.
   *
   * A provider like Codex signs in through a server its CLI runs on the
   * serving machine's loopback — an address only that machine can open. While
   * such a flow is live, everything under `signin/oauth/` is relayed to it:
   * the client forwards the same port locally, the person's browser talks to
   * the client, and the OAuth round trip lands where the CLI is listening.
   *
   * GET and HEAD only. The flows this exists for complete over redirects and
   * query strings; refusing writes keeps the relay from becoming a general
   * tunnel into the serving machine's loopback. The director's answer is the
   * whole gate: a defined port both authorises the relay and names its
   * target, and everything else is the enumeration-proof 404.
   */
  if (oauthRelay) {
    if (method !== 'GET' && method !== 'HEAD') {
      return fail(405, 'invalid_request_error', 'method_not_allowed', 'The sign-in relay takes GET.');
    }
    const port = signIns.loopbackPort(profileId);
    if (port === undefined) return missing();
    const sub = action === 'signin/oauth' ? '/' : action.slice('signin/oauth'.length);
    const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
    let upstream: Response;
    try {
      upstream = await fetch(`http://127.0.0.1:${String(port)}${sub}${query}`, {
        method,
        // Redirects go back to the person's browser untouched: a Location the
        // relay followed itself would complete the provider's hop server-side
        // and strand the flow's own callback.
        redirect: 'manual',
        headers: {
          ...(request.headers['accept'] === undefined ? {} : { accept: request.headers['accept'] }),
          ...(request.headers['cookie'] === undefined ? {} : { cookie: request.headers['cookie'] }),
        },
      });
    } catch {
      return fail(
        502,
        'invalid_request_error',
        'relay_failed',
        'The sign-in flow is no longer listening. Start the sign-in again.',
      );
    }
    const passed: Record<string, string> = {};
    for (const name of ['content-type', 'location', 'set-cookie', 'cache-control']) {
      const value = upstream.headers.get(name);
      if (value !== null) passed[name] = value;
    }
    const text = method === 'HEAD' ? '' : await upstream.text();
    return {
      status: upstream.status,
      headers: passed,
      connectionId: connection.id,
      stream: (async function* () {
        if (text.length > 0) yield text;
      })(),
    };
  }

  /*
   * The account itself: PATCH changes it, DELETE removes it.
   *
   * Everything a local profile's editor writes that makes sense over the
   * wire — label, endpoint address, key — with the local editor's own
   * semantics: omitted leaves a field alone, the empty string clears. The
   * key is write-only in both directions; no reply carries it back.
   */
  if (action === '') {
    if (method === 'PATCH') {
      const body = request.body;
      if (typeof body !== 'object' || body === null) {
        return fail(400, 'invalid_request_error', 'invalid_body', 'The request body must be a JSON object.');
      }
      const patch: { label?: string; baseUrl?: string; apiKey?: string } = {};
      for (const field of ['label', 'baseUrl', 'apiKey'] as const) {
        const value = (body as Record<string, unknown>)[field];
        if (value === undefined) continue;
        if (typeof value !== 'string') {
          return fail(400, 'invalid_request_error', 'invalid_body', `\`${field}\` must be a string.`);
        }
        patch[field] = value;
      }
      if (patch.label !== undefined && patch.label.trim().length === 0) {
        return fail(400, 'invalid_request_error', 'invalid_body', 'A label cannot be empty.');
      }
      if (Object.keys(patch).length === 0) {
        return fail(400, 'invalid_request_error', 'invalid_body', 'The patch names no field to change.');
      }
      try {
        const updated = await admin.update(profileId, patch);
        context.onRemoteAccess?.({
          kind: 'remote.profile.updated',
          connectionId: connection.id,
          profileId,
        });
        const reply: ServerProfileCreatedBody = {
          object: 'artemis.profile',
          id: updated.id,
          label: updated.label,
          providerId: updated.providerId as ProviderId,
          configDir: updated.configDir,
        };
        return ok(reply);
      } catch (error) {
        if (error instanceof DuplicateProfileLabelError) {
          return fail(409, 'invalid_request_error', 'duplicate_label', error.message);
        }
        return fail(
          400,
          'invalid_request_error',
          'invalid_body',
          error instanceof Error ? error.message : 'The account could not be changed.',
        );
      }
    }
    if (method === 'DELETE') {
      const existing = await admin.find(profileId);
      if (existing === undefined) return missing();
      await admin.delete(profileId);
      context.onRemoteAccess?.({
        kind: 'remote.profile.deleted',
        connectionId: connection.id,
        profileId,
        providerId: existing.providerId,
      });
      return ok({ object: 'artemis.profile.deleted', removed: true });
    }
    return missing();
  }

  /**
   * Does the director hold a flow for this id?
   *
   * The guard on every line written about an id that came off the *path*. The
   * two verbs below — submitting a code, cancelling — are the ones a caller can
   * aim at an account that does not exist, and writing the line first (which is
   * what the bridge does, so that a verb followed by a crash still leaves a
   * trace) would otherwise let a caller put an arbitrary string in the log by
   * asking about an account that was never there. Asking the director first
   * costs a map lookup and makes the id a real one.
   */
  const knownFlow = (): boolean => signIns.status(profileId) !== undefined;

  if (action === 'signin/code') {
    if (method !== 'POST') {
      return fail(405, 'invalid_request_error', 'method_not_allowed', 'Submitting a code is a POST.');
    }
    return submitSignInCode(signIns, profileId, request.body, () => {
      if (!knownFlow()) return;
      context.onRemoteAccess?.({
        kind: 'remote.signin.completed',
        connectionId: connection.id,
        profileId,
      });
    });
  }

  if (method === 'GET' || method === 'HEAD') {
    // A read. Not recorded — see the section comment.
    const status = signIns.status(profileId);
    return status === undefined ? noSignIn() : ok(status);
  }
  if (method === 'DELETE') {
    if (knownFlow()) {
      context.onRemoteAccess?.({
        kind: 'remote.signin.cancelled',
        connectionId: connection.id,
        profileId,
      });
    }
    const cancelled = signIns.cancel(profileId);
    return cancelled === undefined ? noSignIn() : ok(cancelled);
  }
  if (method !== 'POST') {
    return fail(
      405,
      'invalid_request_error',
      'method_not_allowed',
      'A sign-in is started with POST, read with GET and abandoned with DELETE.',
    );
  }

  const profile = await admin.find(profileId);
  if (profile === undefined) return unknownProfile();
  // Written before the subprocess is spawned, the way the bridge writes its run
  // verbs: the account is known to exist by now, and a spawn that takes the
  // process down with it should still leave a line saying who asked.
  context.onRemoteAccess?.({
    kind: 'remote.signin.started',
    connectionId: connection.id,
    profileId: String(profile.id),
    providerId: profile.providerId,
  });
  try {
    return ok(signIns.start(profile));
  } catch (error) {
    if (error instanceof SignInBusyError) {
      return fail(409, 'invalid_request_error', 'signin_in_progress', error.message);
    }
    if (error instanceof SignInUnavailableError) {
      return fail(409, 'invalid_request_error', 'signin_unavailable', error.message);
    }
    return fail(
      500,
      'server_error',
      'signin_failed',
      'The sign-in could not be started on this server.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Memory banks: which of this machine's accounts each one reaches             */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/v0/memory-banks` and `PATCH /api/v0/memory-banks/{slug}`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 *
 * A served run has always been given only the banks its account is in scope
 * for — every path that attaches or lists one filters on `scopeCoversProfile`.
 * What was missing was any way to *say* which accounts that is. The desktop
 * writes the scope into its own `memory-banks.json` through its settings pane;
 * a headless server's copy of that file had one writer, a text editor on the
 * serving machine, so in practice every bank on a server was `{kind:'all'}`
 * and reached every account it served.
 *
 * These two routes are the missing writer. The read carries the server's
 * accounts alongside the banks so a client can draw the checklist from one
 * request rather than joining ids against the catalogue itself.
 *
 * ---------------------------------------------------------------------------
 * WHO MAY
 * ---------------------------------------------------------------------------
 *
 * {@link ServerConnection.manageProfiles}, and the enumeration-proof 404 for
 * everyone else — `handleProfileAdminRoute`'s rule, adopted wholesale because
 * the reasoning transfers exactly. Scoping a bank decides what the accounts on
 * this machine may read and write, which is an administrative act on the
 * serving machine and not a thing a connection that merely runs turns should
 * be able to discover, let alone do. The order is the same too: grant first,
 * then the seam, then the body, so a build with no registry answers `501` to
 * an administrator and `404` to everyone else.
 *
 * The write is attributed as `remote.profile.updated`: the line carries ids
 * and never values (see `RemoteAccessEvent`), and what it records is that this
 * token changed what an account on this machine reaches. One line per bank
 * touched would be a second kind saying the same thing about the same act.
 */
async function handleMemoryBankRoute(
  request: ServerRequestInfo,
  context: ServerContext,
  connection: ServerConnection,
  path: string,
  method: string,
): Promise<ServerReply> {
  const missing = (): ServerReply =>
    fail(404, 'invalid_request_error', 'unknown_endpoint', `No route for ${path}.`);

  if (connection.manageProfiles !== true) return missing();

  const banks = context.memoryBanks;
  if (banks === undefined) {
    return fail(
      501,
      'invalid_request_error',
      'not_implemented',
      'This Artemis build serves accounts but keeps no memory-bank registry.',
    );
  }

  const apiPrefix = `/api/${SERVER_API_VERSION}`;

  if (path === `${apiPrefix}/memory-banks`) {
    if (method !== 'GET' && method !== 'HEAD') {
      return fail(
        405,
        'invalid_request_error',
        'method_not_allowed',
        'The bank list is a GET. Scope one with PATCH /api/v0/memory-banks/{slug}.',
      );
    }
    // A read, and so not attributed — the section comment on the account
    // surface says why: a client polls this to draw a pane.
    const body: ServerMemoryBanksBody = {
      object: 'artemis.memory-banks',
      banks: await banks.list(),
      profiles: await serverAccounts(context),
    };
    return ok(body);
  }

  let slug: string;
  try {
    slug = decodeURIComponent(path.slice(`${apiPrefix}/memory-banks/`.length));
  } catch {
    return fail(400, 'invalid_request_error', 'invalid_url', 'The bank slug could not be parsed.');
  }
  // A slug with a slash in it is a sub-path this surface does not have, not a
  // bank with an odd name: the registry's own slugs are `[a-z0-9-]`.
  if (slug.length === 0 || slug.includes('/')) return missing();

  if (method !== 'PATCH') {
    return fail(
      405,
      'invalid_request_error',
      'method_not_allowed',
      "A bank's accounts are changed with PATCH.",
    );
  }

  const body = request.body;
  if (typeof body !== 'object' || body === null) {
    return fail(400, 'invalid_request_error', 'invalid_body', 'The request body must be a JSON object.');
  }
  const scope = parseBankScope((body as Record<string, unknown>)['profiles']);
  if (typeof scope === 'string') {
    return fail(400, 'invalid_request_error', 'invalid_body', scope);
  }
  if (scope.kind === 'profiles') {
    /*
     * Every named account has to exist on this machine.
     *
     * Refused rather than stored, because the failure it prevents is silent:
     * a scope naming an id this server has never had is a bank that reaches
     * nothing, and nothing anywhere would say so — the run would simply start
     * without its memory, which is indistinguishable from the feature being
     * off. A caller told which id is wrong can fix it.
     */
    const known = new Set((await serverAccounts(context)).map((account) => String(account.id)));
    const stranger = scope.profileIds.find((id) => !known.has(id));
    if (stranger !== undefined) {
      return fail(
        400,
        'invalid_request_error',
        'unknown_profile',
        `No account on this server has the id "${stranger}". List them at ${apiPrefix}/profiles.`,
      );
    }
  }

  let updated: ServerMemoryBank | undefined;
  try {
    updated = await banks.setScope(slug, scope);
  } catch (error) {
    return fail(
      500,
      'server_error',
      'registry_write_failed',
      error instanceof Error ? error.message : 'The bank registry could not be written.',
    );
  }
  if (updated === undefined) {
    return fail(
      404,
      'invalid_request_error',
      'unknown_bank',
      `No memory bank called "${slug}" is registered on this server.`,
    );
  }
  context.onRemoteAccess?.({
    kind: 'remote.profile.updated',
    connectionId: connection.id,
  });
  const reply: ServerMemoryBankBody = { object: 'artemis.memory-bank', bank: updated };
  return ok(reply);
}

/* -------------------------------------------------------------------------- */
/* Skills: what this machine carries, and the repositories it clones them from */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/v0/skills`, and the writes under `/api/v0/skills/`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 *
 * A served run is offered the *server's* skills, so a client that wants to
 * show a person what they can type, or let them keep one always on, has to ask
 * the server what it has. And a server is the one machine nobody sits at: the
 * repositories a person keeps cloned everywhere else have no way onto it but
 * this.
 *
 * ---------------------------------------------------------------------------
 * WHO MAY
 * ---------------------------------------------------------------------------
 *
 * The read is any connection's, narrowed to the accounts it can see — the rule
 * `/commands` already follows, and for the same reason: it says nothing a turn
 * on the same token could not find by listing a folder.
 *
 * The writes need {@link ServerConnection.manageProfiles}. Refused with `403`
 * and a sentence rather than the enumeration-proof `404` the account surface
 * uses, because there is nothing to hide: the read beside them is open, so the
 * path is known to exist, and a person whose token lacks the grant is better
 * served by being told so than by a route that pretends not to be there.
 *
 * Each write is attributed as `remote.profile.updated`, on the memory-bank
 * surface's reasoning: what the line records is that this token changed what
 * the accounts on this machine are given.
 */
async function handleSkillsRoute(
  request: ServerRequestInfo,
  context: ServerContext,
  connection: ServerConnection,
  path: string,
  method: string,
  visibleProfiles: () => Promise<readonly ServerProfile[]>,
): Promise<ServerReply> {
  const admin = context.skills;
  if (admin === undefined) {
    return fail(
      501,
      'invalid_request_error',
      'not_implemented',
      'This Artemis build serves accounts but carries no skills of its own.',
    );
  }

  const apiPrefix = `/api/${SERVER_API_VERSION}`;
  const manage = connection.manageProfiles === true;

  /** The whole state, read after whatever the request did. */
  const state = async (): Promise<ServerReply> => {
    // An administrator is administering the machine, so sees every account's
    // folder; anyone else sees the accounts they can run turns on.
    const accounts = manage ? await serverAccounts(context) : (await visibleProfiles()).map(
      (profile): ServerMemoryBankAccount => ({ id: profile.id, slug: profile.slug, label: profile.label }),
    );
    const { skills, sources } = await admin.list({ profileIds: accounts.map((account) => String(account.id)) });
    const body: ServerSkillsBody = { object: 'artemis.skills', skills, sources, profiles: accounts, manage };
    return ok(body);
  };

  if (path === `${apiPrefix}/skills`) {
    if (method !== 'GET' && method !== 'HEAD') {
      return fail(
        405,
        'invalid_request_error',
        'method_not_allowed',
        `The skill list is a GET. Add a repository with POST ${apiPrefix}/skills/sources.`,
      );
    }
    return state();
  }

  const rest = path.slice(`${apiPrefix}/skills/`.length);
  const isWrite =
    rest === 'sync' || rest === 'sources' || /^sources\/[^/]+(\/sync)?$/.test(rest);
  if (!isWrite) return fail(404, 'invalid_request_error', 'unknown_endpoint', `No route for ${path}.`);
  if (!manage) {
    return fail(
      403,
      'invalid_request_error',
      'not_permitted',
      'This connection may read the skills on this server but not change its repositories. Create one with --manage-profiles to do that.',
    );
  }
  const attributed = async (): Promise<ServerReply> => {
    context.onRemoteAccess?.({ kind: 'remote.profile.updated', connectionId: connection.id });
    return state();
  };
  const wrongMethod = (allowed: string): ServerReply =>
    fail(405, 'invalid_request_error', 'method_not_allowed', `${path} takes ${allowed}.`);

  if (rest === 'sync') {
    if (method !== 'POST') return wrongMethod('POST');
    await admin.syncSources();
    return attributed();
  }

  if (rest === 'sources') {
    if (method !== 'POST') return wrongMethod('POST');
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return fail(400, 'invalid_request_error', 'invalid_body', 'The request body must be a JSON object.');
    }
    const record = body as Record<string, unknown>;
    const url = typeof record['url'] === 'string' ? record['url'].trim() : '';
    const subdir =
      record['subdir'] === undefined
        ? DEFAULT_SKILL_SOURCE_SUBDIR
        : typeof record['subdir'] === 'string'
          ? record['subdir'].trim()
          : null;
    // The desktop's own rules, from the one place they are written: what this
    // refuses is what the pane refuses before it sends, in the same words.
    const problem =
      subdir === null
        ? '`subdir` must be a string.'
        : (skillSourceUrlProblem(url) ?? skillSourceSubdirProblem(subdir));
    if (problem !== null || subdir === null) {
      return fail(400, 'invalid_request_error', 'invalid_body', problem ?? '`subdir` must be a string.');
    }
    const refused = await admin.addSource({ url, subdir });
    if (refused !== null) return fail(400, 'invalid_request_error', 'source_limit', refused);
    return attributed();
  }

  // `sources/{id}` and `sources/{id}/sync`.
  const [, encodedId = '', action] = rest.split('/');
  let id: string;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    return fail(400, 'invalid_request_error', 'invalid_url', 'The source id could not be parsed.');
  }
  const unknown = (): ServerReply =>
    fail(404, 'invalid_request_error', 'unknown_source', `No skill repository with the id "${id}" is kept on this server.`);

  if (action === 'sync') {
    if (method !== 'POST') return wrongMethod('POST');
    return (await admin.syncSources(id)) ? attributed() : unknown();
  }
  if (method !== 'DELETE') return wrongMethod('DELETE');
  return (await admin.removeSource(id)) ? attributed() : unknown();
}

/**
 * Every account on the serving machine, as the scope picker needs it.
 *
 * The *whole* catalogue rather than {@link visibleToConnection}'s narrowing,
 * which is the same choice the account-administration routes make: they too
 * act on the store rather than on what this token may run turns against. A
 * connection restricted to one account but granted administration is still
 * administering the machine, and a picker that hid the accounts it is allowed
 * to scope a bank to would produce scopes nobody could explain.
 */
async function serverAccounts(context: ServerContext): Promise<readonly ServerMemoryBankAccount[]> {
  const profiles = await context.catalogue.read();
  return profiles.map((profile) => ({ id: profile.id, slug: profile.slug, label: profile.label }));
}

/**
 * Read a scope off the wire. A sentence on refusal, so the caller can correct
 * it — this is a body an administrator wrote, not a value from a stranger.
 *
 * Nothing is coerced. An unparsable scope used to become `{kind:'all'}` in the
 * registry's own reader, which is the right default for a file somebody edited
 * by hand and exactly the wrong one here: a typo in a PATCH would widen a bank
 * to every account on the machine.
 */
function parseBankScope(value: unknown): ServerMemoryBankScope | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return '`profiles` must be `{ "kind": "all" }` or `{ "kind": "profiles", "profileIds": [...] }`.';
  }
  const record = value as Record<string, unknown>;
  if (record['kind'] === 'all') return { kind: 'all' };
  if (record['kind'] !== 'profiles') {
    return '`profiles.kind` must be "all" or "profiles".';
  }
  const ids = record['profileIds'];
  if (!Array.isArray(ids)) return '`profiles.profileIds` must be an array of account ids.';
  if (ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    return '`profiles.profileIds` must hold non-empty account ids.';
  }
  // Duplicates are the caller's, not an error: a checklist that sent one twice
  // means the same thing once, and the registry stores what it is given.
  return { kind: 'profiles', profileIds: [...new Set(ids as string[])] };
}

/** No flow for this account. Not an error state — nobody has started one. */
function noSignIn(): ServerReply {
  return fail(
    404,
    'invalid_request_error',
    'no_signin',
    'No sign-in is in progress for this account.',
  );
}

/**
 * "There is no such account" — and only ever said to a caller holding the
 * administrative grant, who is entitled to know which accounts exist.
 */
function unknownProfile(): ServerReply {
  return fail(404, 'invalid_request_error', 'unknown_profile', 'No such account on this server.');
}

/**
 * Register a serving account. The API twin of `artemis-server profile add`.
 *
 * The provider defaults to `claude` rather than being required, because that is
 * the one whose login this surface can actually drive and a caller that has to
 * name it learns nothing by naming it. A provider this build has no adapter for
 * is refused by the store, whose message says so.
 */
async function createProfileRoute(
  admin: ProfileAdmin,
  body: unknown,
  record: (created: { readonly id: unknown; readonly providerId: string }) => void,
): Promise<ServerReply> {
  if (typeof body !== 'object' || body === null) {
    return fail(400, 'invalid_request_error', 'invalid_body', 'The request body must be a JSON object.');
  }
  const label = (body as { label?: unknown }).label;
  if (typeof label !== 'string' || label.trim().length === 0) {
    return fail(400, 'invalid_request_error', 'invalid_body', '`label` must be a non-empty string.');
  }
  const declared = (body as { provider?: unknown }).provider;
  if (declared !== undefined && (typeof declared !== 'string' || declared.length === 0)) {
    return fail(400, 'invalid_request_error', 'invalid_body', '`provider` must be a provider id, e.g. "claude".');
  }

  try {
    const created = await admin.create({
      label: label.trim(),
      providerId: declared ?? 'claude',
    });
    record(created);
    const reply: ServerProfileCreatedBody = {
      object: 'artemis.profile',
      id: created.id,
      label: created.label,
      providerId: created.providerId as ProviderId,
      configDir: created.configDir,
    };
    return ok(reply);
  } catch (error) {
    if (error instanceof DuplicateProfileLabelError) {
      return fail(409, 'invalid_request_error', 'duplicate_label', error.message);
    }
    /*
     * The store's own message, and this is the one place on this surface where
     * that is right. The caller holds the administrative grant, they are
     * creating a thing on this machine, and the refusals that reach here are
     * about *their input* — an unknown provider, a label that is only
     * whitespace. A caller told "the request failed" has nothing to correct.
     */
    return fail(
      400,
      'invalid_request_error',
      'invalid_profile',
      error instanceof Error ? error.message : 'The account could not be created.',
    );
  }
}

/**
 * The code the user pasted, on its way to the subprocess's stdin.
 *
 * Nothing here logs it, echoes it, or puts it in an error — see the refusals
 * below, which describe the *state* and never the input, and the attribution
 * line, which carries a connection id and an account id and has nowhere to put
 * a third string. It is the one value on this whole surface that is a secret in
 * flight.
 */
function submitSignInCode(
  signIns: SignInDirector,
  profileId: string,
  body: unknown,
  record: () => void,
): ServerReply {
  if (typeof body !== 'object' || body === null) {
    return fail(400, 'invalid_request_error', 'invalid_body', 'The request body must be a JSON object.');
  }
  const code = (body as { code?: unknown }).code;
  if (typeof code !== 'string' || code.trim().length === 0) {
    return fail(400, 'invalid_request_error', 'invalid_body', '`code` must be a non-empty string.');
  }
  // A newline in the middle would be read by the CLI as the end of the answer
  // and the start of another, so it is refused rather than trimmed: a pasted
  // value carrying one is not the code the provider showed.
  if (/[\r\n]/.test(code)) {
    return fail(400, 'invalid_request_error', 'invalid_body', 'A code cannot contain a line break.');
  }

  record();
  try {
    return ok(signIns.submitCode(profileId, code.trim()));
  } catch (error) {
    if (error instanceof SignInNotWaitingError) {
      return fail(409, 'invalid_request_error', 'signin_not_waiting', error.message);
    }
    return fail(500, 'server_error', 'signin_failed', 'The code could not be delivered.');
  }
}

/**
 * The scoped ledger entries, enriched from the provider's own store.
 *
 * The ledger authorises; the store describes. An entry whose transcript the
 * store no longer has — deleted on the serving machine — is dropped rather
 * than listed as a row that cannot be opened. Reads are grouped by the
 * (profile × directory) partition the stores are organised in, so a
 * directory-pinned connection costs one read per visible profile rather than
 * one per conversation.
 */
async function describeScopedSessions(
  sessions: SessionSource,
  ledger: SessionLedger,
  scope: LedgerScope,
  profiles: readonly ServerProfile[],
): Promise<readonly ServerSessionSummary[]> {
  const entries = ledger.listFor(scope);
  if (entries.length === 0) return [];

  const bySlug = new Map(profiles.map((profile) => [String(profile.id), profile]));

  const groups = new Map<string, { profileId: string; cwd: string; ids: Set<string> }>();
  for (const entry of entries) {
    const key = `${entry.profileId}\u0000${entry.cwd}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { profileId: entry.profileId, cwd: entry.cwd, ids: new Set() };
      groups.set(key, group);
    }
    group.ids.add(entry.sessionId);
  }

  /*
   * One read per (profile × directory), kept, so the second pass below can
   * consult a store the first pass already opened without opening it again.
   */
  const pages = new Map<string, readonly SessionSummary[]>();
  const pageFor = async (
    profile: ServerProfile,
    cwd: string,
  ): Promise<readonly SessionSummary[]> => {
    const key = `${String(profile.id)}\u0000${cwd}`;
    const cached = pages.get(key);
    if (cached !== undefined) return cached;
    let page: readonly SessionSummary[] = [];
    try {
      page = (
        await sessions.list({
          providerId: String(profile.provider.id),
          profileId: String(profile.id),
          cwd,
          limit: 200,
        })
      ).sessions;
    } catch {
      // One unreadable store must not fail the listing — the other groups'
      // conversations are still real. The missing ones simply do not appear,
      // which is also what a store mid-rotation looks like.
    }
    pages.set(key, page);
    return page;
  };

  /** Each conversation a store could describe, and whose store it was in. */
  const described = new Map<string, { summary: SessionSummary; profileId: string }>();
  for (const group of groups.values()) {
    const profile = bySlug.get(group.profileId);
    if (profile === undefined) continue;
    for (const summary of await pageFor(profile, group.cwd)) {
      const id = String(summary.id);
      if (group.ids.has(id)) described.set(id, { summary, profileId: group.profileId });
    }
  }

  /*
   * The second pass: entries whose transcript the ledger's own account does
   * not hold.
   *
   * Dropping them was what made a conversation vanish with its transcript
   * intact. The ledger is last-writer-wins and is written the moment a resume
   * is accepted — before the provider has looked for the file — so a resume
   * sent on the wrong account re-recorded the session against that account,
   * and every listing after that looked in the wrong store. The transcript
   * was in another visible store the whole time. So the other stores are
   * asked for that directory, the row is reported under the account that
   * actually holds it, and the ledger is corrected so the next listing needs
   * no second pass. Only an entry no visible store can describe is dropped,
   * and that one really is gone.
   */
  for (const entry of entries) {
    if (described.has(entry.sessionId)) continue;
    for (const profile of profiles) {
      if (String(profile.id) === entry.profileId) continue;
      const summary = (await pageFor(profile, entry.cwd)).find(
        (candidate) => String(candidate.id) === entry.sessionId,
      );
      if (summary === undefined) continue;
      described.set(entry.sessionId, { summary, profileId: String(profile.id) });
      ledger.reattribute(entry.sessionId, String(profile.id));
      break;
    }
  }

  const rows: ServerSessionSummary[] = [];
  for (const entry of entries) {
    const found = described.get(entry.sessionId);
    if (found === undefined) continue;
    const { summary } = found;
    const profile = bySlug.get(found.profileId);
    rows.push({
      id: entry.sessionId,
      title: summary.title,
      ...(summary.firstPrompt === undefined ? {} : { firstPrompt: summary.firstPrompt }),
      updatedAt: summary.updatedAt,
      profileSlug: profile?.slug ?? found.profileId,
      // The ledger's account, not the store's: `SessionSummary.profileId` is a
      // pick when several profiles reach one store (see `profileIsUnknown`),
      // and the ledger *knows* which connection ran this one — corrected
      // above where the store it named turned out not to hold the file. The
      // provider is the account's own, which is the only one it could have
      // been.
      profileId: found.profileId,
      providerId: String(profile?.provider.id ?? summary.providerId),
      // The store's own tag, so a client can tell an archived conversation
      // from a live one. The tag route writes this; dropping it here made
      // that write invisible.
      ...(summary.tag === undefined ? {} : { tag: summary.tag }),
      cwd: entry.cwd,
      ...(entry.origin === 'bridge' ? { origin: 'bridge' as const } : {}),
    });
  }
  return rows;
}

async function handleChatCompletions(
  request: ServerRequestInfo,
  context: ServerContext,
  connection: ServerConnection,
): Promise<ServerReply | ServerStreamReply> {
  const attribute = <T extends { status: number }>(reply: T): T & { connectionId: string } => ({
    ...reply,
    connectionId: connection.id,
  });

  if (context.runs === undefined || context.workspaces === undefined) {
    return attribute(
      fail(
        501,
        'invalid_request_error',
        'not_implemented',
        "This Artemis build serves its catalogue but cannot run turns.",
      ),
    );
  }

  const body = request.body;
  if (typeof body !== 'object' || body === null) {
    return attribute(
      fail(400, 'invalid_request_error', 'invalid_body', 'The request body must be a JSON object.'),
    );
  }
  const chat = body as OpenAiChatRequest;

  if (!Array.isArray(chat.messages) || chat.messages.length === 0) {
    return attribute(
      fail(400, 'invalid_request_error', 'invalid_body', '`messages` must be a non-empty array.'),
    );
  }
  if (typeof chat.model !== 'string' || chat.model.length === 0) {
    return attribute(
      fail(400, 'invalid_request_error', 'invalid_body', '`model` must be a route, e.g. `work-max/opus`.'),
    );
  }

  let extensions: ArtemisChatExtensions;
  try {
    // The one field in here that throws rather than dropping: an attachment is
    // the subject of the message, not a setting on it. See its own note.
    extensions = readChatExtensions(body);
  } catch (error) {
    return attribute(attachmentFailure(error));
  }
  // Bounded where the request is validated, per the wire type's promise. The
  // whole body is already capped, but a system prompt is the one caller-supplied
  // string large enough to be worth its own limit — mirroring `runInput.ts`'s
  // `LIMITS.systemPrompt`, so the completions and bridge surfaces agree.
  if (extensions.systemPrompt !== undefined && extensions.systemPrompt.length > 200_000) {
    return attribute(
      fail(
        400,
        'invalid_request_error',
        'invalid_body',
        '`artemis.systemPrompt` is too long (max 200000 characters).',
      ),
    );
  }
  /*
   * `ignoreUnsupported` is read here rather than in `readChatExtensions`
   * because it is not a *setting for the run* — it changes how this request is
   * validated, and nothing downstream should be able to see it and act on it.
   */
  const lenient =
    (body as { artemis?: { ignoreUnsupported?: unknown } }).artemis?.ignoreUnsupported === true;
  const review = reviewParameters(body, { lenient });
  if (review.rejected.length > 0) {
    return attribute(
      fail(
        400,
        'invalid_request_error',
        'unsupported_parameter',
        `Artemis cannot honour ${review.rejected.join(', ')}, and will not accept a request that would be silently changed by ignoring them. Send \`artemis.ignoreUnsupported: true\` to proceed anyway.`,
      ),
    );
  }

  // The route is resolved against what *this connection* may see, so a model
  // outside its allowance is indistinguishable from one that does not exist.
  const profiles = visibleToConnection(connection, await context.catalogue.read({}));
  const requested = findModel(profiles, chat.model);
  if (requested === undefined) {
    return attribute(modelNotFound(chat.model));
  }

  /*
   * The resume gate. A `sessionId` names a stored conversation, and the only
   * conversations a token may re-enter are the ones its own scope created —
   * the serving user's desktop history lives in the same store and must be
   * unreachable, and another connection's conversations are another
   * principal's. Same 404 as the session routes, for the same reason: a
   * refusal that distinguished "not there" from "not yours" would let a
   * caller enumerate which ids exist.
   */
  if (extensions.sessionId !== undefined && context.ledger !== undefined) {
    const scope = scopeFor(connection, profiles);
    if (!context.ledger.mayAccess(scope, extensions.sessionId)) {
      return attribute(unknownSession());
    }
  }

  /*
   * The account that holds the conversation continues it.
   *
   * A transcript lives in one account's store and the provider looks nowhere
   * else, so a resume on any other route fails before its first token — and
   * used to take the conversation with it, because the ownership record below
   * was written first. The route is corrected here instead, and the reply says
   * so. Nothing is read on the ordinary path: see `sessionHome.ts`.
   */
  const resumed: { readonly model: ServerModel; readonly redirected?: RouteRedirect } =
    extensions.sessionId === undefined
      ? { model: requested }
      : await resolveResumeModel({
          sessions: context.sessions,
          ledger: context.ledger,
          profiles,
          requested,
          sessionId: extensions.sessionId,
        });
  const { model, redirected } = resumed;

  /*
   * The account behind the route, needed here rather than further down because
   * the steer branch below returns before ever reaching that point and carries
   * attachments of its own.
   */
  const account = profiles.find((profile) => String(profile.id) === String(model.profileId));

  /*
   * Attachments, from both places one request can name them.
   *
   * `artemis.attachments` is what an Artemis client sends; `image_url` content
   * parts are what every off-the-shelf OpenAI client sends, and neither is more
   * correct than the other. They are merged and then held to the ceilings
   * *together*, because each list can be legal on its own while the pair is
   * four images too many.
   */
  let attachments: readonly Attachment[] | undefined;
  try {
    attachments = mergeAttachments(
      extensions.attachments,
      attachmentsFromMessages(chat.messages),
      `${CHAT_EXTENSIONS_FIELD}.attachments`,
    );
  } catch (error) {
    return attribute(attachmentFailure(error));
  }

  /*
   * Refused rather than dropped, like the fork and the rewind below and for the
   * same reason — only more so. A setting quietly not applied costs the caller
   * a feature; a screenshot quietly not delivered costs them the question, and
   * the answer comes back confident and about nothing. The account's own
   * `imageInput` and `fileInput` decide it, because a server fronts several
   * providers and they do not agree.
   */
  const unsupported = unsupportedAttachment(attachments, account?.capabilities);
  if (unsupported !== undefined) {
    return attribute(
      fail(
        400,
        'invalid_request_error',
        'unsupported_parameter',
        `The account behind ${model.route} cannot accept ${unsupported} in a prompt.`,
      ),
    );
  }
  if (attachments !== undefined) extensions = { ...extensions, attachments };

  /*
   * A message to a conversation the server is still working on is a steer,
   * not a second run.
   *
   * The server can be working on a conversation with no client attached:
   * the provider opens a turn of its own when a subagent finishes, and the
   * registry adopts it, while the client that started the conversation saw
   * its last turn end and shows an idle pane. What that client sends next —
   * "did the session stop? keep going", on 2026-09-16 — arrives here as an
   * ordinary resume. Starting a run on it put a second CLI on a transcript
   * the first was still writing; the adapters now refuse that, and a refusal
   * alone would lose the message. So it goes into the live run as the steer
   * it was, and the caller follows that run from the start — everything it
   * missed, then the live tail — which is the answer to what it was asking.
   */
  if (extensions.sessionId !== undefined) {
    const live = await liveRunOn(context.runs, extensions.sessionId);
    if (live !== undefined) {
      return attribute(
        await steerLiveRun({
          context,
          connection,
          request,
          chat,
          extensions,
          model,
          live,
          ignored: review.ignored,
          ...(redirected === undefined ? {} : { redirected }),
        }),
      );
    }
  }

  /*
   * Standing instructions reach the run only where the serving account's
   * provider can append to its preset. Codex and OpenCode have no append —
   * `systemPromptAppend: false` on their descriptors, and the catalogue
   * publishes that per account — and their adapters never read the field, so
   * a prompt handed to them would be accepted and silently unread. That is the
   * one failure the capability flag exists to prevent, and it is the reverse of
   * the permission mode's convention: a mode is dropped quietly because the
   * run then opens in the serving user's setting, which is a real outcome; an
   * instruction the model never saw is not an outcome, it is a client that
   * believes it was heard. So the field is dropped *and reported*, under
   * `artemis.ignored` beside any lenient parameter, and a client can say so.
   *
   * `account` itself is resolved above, before the steer branch returns.
   */

  /*
   * Forking and rewinding, refused rather than dropped.
   *
   * Both reshape the conversation the caller is continuing — a fork writes the
   * next turn to a new session, a rewind cuts the stored one before it — and
   * a request for either that was quietly set aside would produce the worst
   * kind of wrong answer: a turn appended to the conversation the caller
   * believed they had branched from or wound back. So each needs the session
   * it acts on, and the serving account's provider has to be able to honour
   * it; the catalogue publishes both flags per account for exactly this
   * check, and the registry behind the run would refuse anyway, only later
   * and with less to say.
   */
  if (extensions.forkSession === true || extensions.rewindToMessageId !== undefined) {
    const wanted = extensions.forkSession === true ? 'artemis.forkSession' : 'artemis.rewindToMessageId';
    if (extensions.sessionId === undefined) {
      return attribute(
        fail(
          400,
          'invalid_request_error',
          'invalid_body',
          `\`${wanted}\` needs \`artemis.sessionId\`: there is no conversation to ${extensions.forkSession === true ? 'fork' : 'rewind'}.`,
        ),
      );
    }
    const capable =
      extensions.forkSession === true
        ? account?.capabilities.forkSession === true
        : account?.capabilities.rewind === true;
    if (!capable) {
      return attribute(
        fail(
          400,
          'invalid_request_error',
          'unsupported_parameter',
          `The account behind ${model.route} cannot ${extensions.forkSession === true ? 'fork' : 'rewind'} a conversation, so \`${wanted}\` cannot be honoured.`,
        ),
      );
    }
  }

  // Both are text appended to the provider's preset, so one capability
  // decides both, and each is named separately: a client told only that its
  // instructions were dropped would still believe its skills were read.
  const { systemPrompt, alwaysOnSkills, ...withoutAppends } = extensions;
  const canAppend = account?.capabilities.systemPromptAppend === true;

  /*
   * Chrome, dropped *and reported* on the same reasoning as the appends: a
   * client whose request for a browser was quietly set aside shows its user a
   * switch that is on and an agent that cannot browse. Two separate noes - the
   * provider has no bridge, or this host's operator has not allowed one - and
   * either is enough. See `ArtemisChatExtensions.chromeBrowser` for why the
   * second exists.
   */
  const mayBrowse =
    account?.capabilities.chromeBridge === true && context.allowChromeBrowser === true;
  /*
   * The caller's own browser, dropped and reported on the same reasoning and
   * with a different shape of no. There is no capability to check — the point
   * of `artemis.extensionBrowser` is that it works for every provider — so the
   * two noes are: this build has no relay to publish verbs on, and the
   * operator turned it off. Absent is *on* here, unlike Chrome above; see
   * `ServerContext.allowClientBrowser`.
   */
  const mayRelay = context.browserRelay !== undefined && context.allowClientBrowser !== false;
  const kept = canAppend ? extensions : withoutAppends;
  const { chromeBrowser: _noChrome, ...withoutChrome } = kept;
  const { extensionBrowser: _noRelay, ...withoutRelay } = kept;
  const { chromeBrowser: _alsoNoChrome, extensionBrowser: _alsoNoRelay, ...withoutEither } = kept;
  const droppedChrome = extensions.chromeBrowser === true && !mayBrowse;
  const droppedRelay = extensions.extensionBrowser === true && !mayRelay;
  const applied: ArtemisChatExtensions = droppedChrome
    ? droppedRelay
      ? withoutEither
      : withoutChrome
    : droppedRelay
      ? withoutRelay
      : kept;
  const ignored: readonly string[] = [
    ...review.ignored,
    ...(canAppend || systemPrompt === undefined ? [] : ['artemis.systemPrompt']),
    ...(canAppend || alwaysOnSkills === undefined ? [] : ['artemis.alwaysOnSkills']),
    ...(droppedChrome ? ['artemis.chromeBrowser'] : []),
    ...(droppedRelay ? ['artemis.extensionBrowser'] : []),
  ];

  let workspace;
  try {
    workspace = await context.workspaces.resolve({
      connectionId: connection.id,
      workspace: connection.workspace,
      ...(extensions.sessionId === undefined ? {} : { sessionId: extensions.sessionId }),
    });
  } catch (error) {
    // A catalogue-only connection, or a folder the user has since deleted.
    // 403 rather than 500: the caller asked for something they are not allowed
    // or able to have, and the message says which.
    return attribute(
      fail(
        403,
        'invalid_request_error',
        'workspace_unavailable',
        error instanceof WorkspaceUnavailableError
          ? error.message
          : 'This connection has nowhere to run turns.',
      ),
    );
  }

  const id = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const directory = context.runDirectory;
  /*
   * Ownership is recorded the moment the run has an id, and for every run —
   * not only the ones that opted into surviving a disconnect. The three run
   * actions authorise against this record, so a run that was never claimed is
   * a run its own caller cannot interrupt; and a claim is the cheapest
   * possible way to make "not yours" and "never existed" the same answer for
   * everyone else.
   *
   * Note what is *not* here: `guard.trackRun`. A completions run is governed by
   * this directory's deadline and never by the bridge's grace period — the two
   * registries are separated at the point of creation, which is here and in the
   * bridge's own start route. See `runs.ts`.
   */
  const claim = (runId: string): void => {
    directory?.claim({
      runId,
      connectionId: connection.id,
      permissions: extensions.remote?.permissions === true,
      route: model.route,
    });
  };
  const slashCommands = await commandsBehind(context, model, workspace.path);
  const turn = {
    model,
    cwd: workspace.path,
    request: chat,
    extensions: applied,
    // Read only by `artemis.extensionBrowser`, whose verbs go back down this
    // connection and are answered by nothing else. See `browserRelay.ts`.
    connectionId: connection.id,
    ignored,
    ...(slashCommands === undefined ? {} : { slashCommands }),
    ...(redirected === undefined ? {} : { redirected }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    // Absent when this build has no directory: with nothing to hold the
    // deadline, a detach would be an abandonment, so the turn keeps its old
    // teardown and the opt-in is inert rather than dangerous.
    ...(directory === undefined
      ? {}
      : { onDetach: (runId: RunId) => directory.noteDetached(runId) }),
  };

  /*
   * Ownership is written the moment a session id is knowable: at resume time
   * (the gate above has already proven the claim), and again whenever the run
   * announces one — re-recording refreshes recency and costs nothing. This is
   * the record the session routes and the resume gate read, so it lives here,
   * where the connection is, rather than in the host's RunSource where it
   * would have to be threaded per call.
   */
  const record = (sessionId: string): void => {
    context.ledger?.record({
      sessionId,
      connectionId: connection.id,
      profileId: String(model.profileId),
      workspaceKey: workspaceKeyFor(connection),
      cwd: workspace.path,
    });
  };
  if (extensions.sessionId !== undefined) record(extensions.sessionId);

  if (chat.stream === true) {
    return {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        // The three headers an SSE stream needs. `no-transform` is the one
        // people forget: a proxy that gzips this will buffer it, and a stream
        // that arrives all at once is not a stream.
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
      connectionId: connection.id,
      stream: streamTurn({
        id,
        created,
        turn,
        runs: context.runs,
        model,
        record,
        claim,
        heartbeatMs: context.remoteStream?.heartbeatMs ?? DEFAULT_COMPLETIONS_HEARTBEAT_MS,
        ...(context.onRunFailure === undefined ? {} : { report: context.onRunFailure }),
      }),
    };
  }

  let result: TurnResult | undefined;
  for await (const event of runTurn(context.runs, turn)) {
    if (event.kind === 'run') claim(event.runId);
    if (event.kind === 'session') record(event.sessionId);
    if (event.kind === 'done') {
      result = event.result;
      if (result.sessionId !== undefined) record(result.sessionId);
    }
  }

  if (result === undefined) {
    return attribute(
      fail(502, 'server_error', 'no_result', 'The run ended without producing a reply.'),
    );
  }
  if (result.error !== undefined && result.text.length === 0) {
    // A failure with nothing to show for it is an error; one that produced text
    // before failing is a reply with a reason attached, and throwing that away
    // would lose work the user has already paid for.
    return attribute(fail(502, 'server_error', 'run_failed', result.error));
  }

  return attribute({
    status: 200,
    headers: { ...JSON_HEADERS, ...CORS_HEADERS },
    body: chatResponse({
      id,
      model: model.route,
      created,
      result,
      ignored,
      ...(redirected === undefined ? {} : { redirected }),
      ...(model.resolvedModel === undefined ? {} : { resolvedModel: model.resolvedModel }),
    }),
  });
}

/** How often a quiet completions stream writes a comment. See {@link paced}. */
const DEFAULT_COMPLETIONS_HEARTBEAT_MS = 15_000;

/** What {@link paced} yields when its source has been quiet for a heartbeat. */
const HEARTBEAT = Symbol('heartbeat');

/**
 * Pull from a generator, and say something when it has nothing to say.
 *
 * An SSE stream that is silent for minutes — an agent inside a long tool call
 * produces no chunk between the call's start and its end — is
 * indistinguishable, from the client's side, from a connection that has died.
 * The bridge's feed solved this with a heartbeat comment; the completions
 * stream had none, so a client could not tell a working agent from a dead
 * socket, and a NAT or relay with an idle timeout could cut a quiet stream
 * without either side noticing until the next write.
 * This is the same heartbeat for this stream: while the source has no next
 * value within `heartbeatMs`, a comment is yielded instead and the source's
 * pending `next()` is raced again — never called twice.
 *
 * `finally` returns the source, so a consumer that walks away (a client that
 * hung up) tears the turn down exactly as `for await` would have.
 */
async function* paced<T>(
  source: AsyncGenerator<T>,
  heartbeatMs: number,
): AsyncGenerator<T | typeof HEARTBEAT> {
  try {
    let next = source.next();
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = new Promise<typeof HEARTBEAT>((resolve) => {
        timer = setTimeout(() => resolve(HEARTBEAT), heartbeatMs);
      });
      const outcome = await Promise.race([next, tick]);
      if (timer !== undefined) clearTimeout(timer);
      if (outcome === HEARTBEAT) {
        yield HEARTBEAT;
        continue;
      }
      if (outcome.done === true) return;
      yield outcome.value;
      next = source.next();
    }
  } finally {
    await source.return(undefined);
  }
}

/** The three fields every chunk of one stream shares. */
interface ChunkFrame {
  readonly id: string;
  readonly model: string;
  readonly created: number;
}

/**
 * One turn event as the chunk that carries it, or `undefined` for one that
 * rides on no chunk of its own.
 *
 * Shared by the original stream and a resumed one, which is the point: a
 * client that comes back must be shown the same bytes for the same event it
 * would have seen had its socket held. Every chunk translated from a run event
 * carries that event's `seq` on the Artemis namespace — the cursor a client
 * resumes from — and the ones that come from nowhere in the event stream
 * carry none.
 */
function chunkFor(
  event: TurnEvent,
  frame: ChunkFrame,
  hooks: {
    /** Called once with the run's id, before anything else is written. */
    readonly claim?: (runId: string) => void;
    /** Called with every session id the run announces. See the ledger. */
    readonly record?: (sessionId: string) => void;
    /** Where a failed run is said out loud on the serving machine. */
    readonly report?: (error: unknown) => void;
  },
): OpenAiChatChunk | undefined {
  const seq = event.seq === undefined ? {} : { seq: event.seq };
  const stamped = (extensions: Record<string, unknown>) =>
    Object.keys(extensions).length === 0 && event.seq === undefined
      ? {}
      : { artemis: { ...extensions, ...seq } as OpenAiChatChunk['artemis'] };

  switch (event.kind) {
    case 'text':
      return chatChunk({ ...frame, delta: { content: event.text }, ...stamped({}) });

    // The agent's reasoning, on the field the reasoning-capable OpenAI-shaped
    // servers already use and never on `content`. An OpenAI client that does
    // not know the field appends nothing; an Artemis client draws a thinking
    // row from it — which is the whole reason it is here: without it, a
    // served turn showed its answer and none of the thinking behind it.
    case 'thinking':
      return chatChunk({ ...frame, delta: { reasoning_content: event.text }, ...stamped({}) });

    // The run id, first of everything the turn has to say, and on the same
    // empty-delta chunk the session id rides — an OpenAI client appends
    // nothing and moves on. This is the only place a completions caller can
    // learn the id, and the run actions take it, so a client that means to
    // steer or reattach after the stream breaks has to be holding it before
    // it does.
    case 'run':
      hooks.claim?.(event.runId);
      return chatChunk({
        ...frame,
        delta: {},
        ...stamped({
          runId: event.runId,
          // The seam beside the address, when the registry measured one: the
          // client that started this run is the one that cannot count it.
          ...(event.historyOffset === undefined ? {} : { historyOffset: event.historyOffset }),
        }),
      });

    // A prompt the run is parked on, or the news that it is settled. Only for
    // a caller that asked for these; see `ArtemisRemoteOptions`. Its answer
    // comes back on POST /api/v0/runs/{runId}/permission rather than on this
    // stream, because a stream is one-way and this one is often already dead
    // by the time anyone looks at the question.
    case 'permission':
      return chatChunk({ ...frame, delta: {}, ...stamped({ permission: event.notice }) });

    // The session id, the moment the run reports one — an empty delta with
    // only the Artemis namespace filled in. OpenAI clients append nothing and
    // move on; an Artemis client resumes from it, and a stream that dies
    // mid-turn has still told its caller where the conversation lives. The
    // final chunk repeats it, which is what pre-existing clients read.
    case 'session':
      hooks.record?.(event.sessionId);
      return chatChunk({ ...frame, delta: {}, ...stamped({ sessionId: event.sessionId }) });

    // Only ever on a resumed stream: the server no longer holds everything
    // that was asked for, and says so before sending what it has.
    case 'gap':
      return chatChunk({
        ...frame,
        delta: {},
        ...stamped({ gap: { afterSeq: event.afterSeq, firstSeq: event.firstSeq } }),
      });

    // One of the agent's own tool calls, as it starts and again as it ends,
    // on the same empty delta: an OpenAI client appends nothing, an Artemis
    // client draws the row while the call runs. A well-formed chunk and not a
    // line of its own, because an OpenAI client parses every `data:` line as
    // a chunk and one it cannot parse is a hard error in most SDKs. The whole
    // report still rides the final chunk, which is all an older client reads;
    // until this, that was the only place a call appeared, so a served turn
    // sat still for minutes and then drew every call at once.
    case 'activity':
      return chatChunk({ ...frame, delta: {}, ...stamped({ tool: event.activity }) });

    // What the run has delegated, on an empty delta: an OpenAI client appends
    // nothing, an Artemis client redraws its rows. The whole set each time,
    // which is the event's own contract.
    case 'tasks':
      return chatChunk({ ...frame, delta: {}, ...stamped({ tasks: event.tasks }) });

    // How full the conversation is, on the same empty delta. `usage` could not
    // carry it — see `ArtemisContextReading` — and waiting for the final chunk
    // would mean the reading only ever arrives once there is nothing left to
    // decide with it. An OpenAI client appends nothing; an Artemis client moves
    // its context gauge while the turn is still running.
    case 'context':
      return chatChunk({ ...frame, delta: {}, ...stamped({ context: event.reading }) });

    // A steered message was read. Same empty delta; the client clears its
    // "queued" marker.
    case 'delivered':
      return chatChunk({ ...frame, delta: {}, ...stamped({ delivered: event.messageId }) });

    // Nothing but the cursor: the run moved and the wire had no words for
    // it. An OpenAI client appends nothing; an Artemis client advances the
    // position it would resume from, and can tell a quiet agent from a
    // stream that has stalled. See the kind's own comment.
    case 'cursor':
      return chatChunk({ ...frame, delta: {}, ...stamped({}) });

    case 'done': {
      const { result } = event;
      if (result.sessionId !== undefined) hooks.record?.(result.sessionId);
      // Said out loud on the way past. A streamed failure reaches its caller,
      // so it is not what `onError` was written for — but it left no trace
      // anywhere on the serving machine either, and "the run failed" with the
      // reason only ever travelling *away* from the server is what made this
      // undiagnosable from the side that could actually fix it.
      if (result.error !== undefined) {
        hooks.report?.(new Error(`run on ${frame.model} failed: ${result.error}`));
      }
      return chatChunk({
        ...frame,
        delta: {},
        finishReason: result.finishReason,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        artemis: {
          ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
          ...(result.activity.length === 0 ? {} : { activity: result.activity }),
          // Repeated here even though the reading already crossed on its own
          // chunk: a client that reconnected mid-turn, or one that renders only
          // the terminal chunk, must not finish the turn holding no reading at
          // all when the server has one.
          ...(result.context === undefined ? {} : { context: result.context }),
          endReason: result.endReason,
          /*
           * The reason, on the only chunk that can carry it.
           *
           * A stream cannot answer 502 — the 200 went out with the headers
           * — so where the whole-response path returns `result.error` as
           * the body of one, this is the only place the same sentence can
           * be said. Without it a streaming client sees `endReason:
           * "error"` on an empty delta and has nothing to render but a
           * guess, which is exactly what every remote failure looked like:
           * a run that never started, reported as an unexplained one.
           */
          ...(result.error === undefined ? {} : { error: result.error }),
          ...seq,
        },
      });
    }

    default:
      return undefined;
  }
}

/**
 * A mid-stream failure, as the chunk that stops the stream cleanly.
 *
 * A stream cannot change its status code — the 200 went out with the headers
 * — so the failure is reported *in* the stream. A client that sees the socket
 * close without `[DONE]` reports a network error, which is the wrong
 * diagnosis.
 */
function failureChunk(frame: ChunkFrame, error: unknown): OpenAiChatChunk {
  return chatChunk({
    ...frame,
    delta: {
      content: `\n\n[the run failed: ${error instanceof Error ? error.message : 'unknown error'}]`,
    },
    finishReason: 'stop',
  });
}

/**
 * The same turn, as Server-Sent Events.
 *
 * The shape is OpenAI's exactly: a first chunk carrying the role, then one per
 * text fragment, then a chunk with `finish_reason`, then `[DONE]`. Clients
 * depend on that order — several treat the first chunk as the signal that the
 * stream is live, and every one of them stops at the sentinel. A quiet stretch
 * carries a comment every `heartbeatMs`, which the sentinel-reading clients
 * ignore by definition and an Artemis client uses to tell silence from death.
 */
async function* streamTurn(input: {
  readonly id: string;
  readonly created: number;
  readonly turn: Parameters<typeof runTurn>[1];
  readonly runs: RunSource;
  readonly model: ServerModel;
  /** Called with every session id the run announces. See the ledger. */
  readonly record?: (sessionId: string) => void;
  /** Called once with the run's id, before anything else is written. */
  readonly claim?: (runId: string) => void;
  /** Where a failed run is said out loud on the serving machine. */
  readonly report?: (error: unknown) => void;
  readonly heartbeatMs?: number;
}): AsyncIterable<string> {
  const { id, created, model } = input;
  const frame: ChunkFrame = { id, model: model.route, created };
  const hooks = {
    ...(input.claim === undefined ? {} : { claim: input.claim }),
    ...(input.record === undefined ? {} : { record: input.record }),
    ...(input.report === undefined ? {} : { report: input.report }),
  };

  // What was accepted and not applied rides the role chunk — first, so a
  // client learns before the first token that something it sent was set
  // aside. The whole-response shape carries the same list on its `artemis`
  // block; a streaming client had no way to see it at all until now. A resume
  // moved to the account holding the conversation rides the same chunk, for
  // the same reason.
  const { ignored, redirected } = input.turn;
  yield sseEvent(
    chatChunk({
      ...frame,
      delta: { role: 'assistant' },
      ...(ignored.length === 0 && redirected === undefined
        ? {}
        : {
            artemis: {
              ...(ignored.length === 0 ? {} : { ignored }),
              ...(redirected === undefined ? {} : { redirected }),
            },
          }),
    }),
  );

  try {
    const source = paced(
      runTurn(input.runs, input.turn),
      input.heartbeatMs ?? DEFAULT_COMPLETIONS_HEARTBEAT_MS,
    );
    for await (const item of source) {
      if (item === HEARTBEAT) {
        yield SSE_HEARTBEAT;
        continue;
      }
      const chunk = chunkFor(item, frame, hooks);
      if (chunk !== undefined) yield sseEvent(chunk);
    }
  } catch (error) {
    yield sseEvent(failureChunk(frame, error));
  }

  yield sseEvent(SSE_DONE);
}

/**
 * The run still going on a conversation, if the engine has one.
 *
 * `listRuns` answers only live runs, and a handle carries its session id from
 * the moment the run knows it, so this is one scan. A build without the
 * observation surface answers nothing — and its adapters refuse the second
 * run on their own, so the outcome there is a refusal rather than a fork.
 */
async function liveRunOn(
  runs: RunSource | undefined,
  sessionId: string,
): Promise<RunHandle | undefined> {
  if (runs?.listRuns === undefined) return undefined;
  const handles = await runs.listRuns({});
  return handles.find(
    (handle) => handle.status !== 'ended' && String(handle.sessionId) === sessionId,
  );
}

/**
 * The `artemis.*` fields a steer cannot carry, named so the caller knows.
 *
 * A turn already running has its mode, its effort and its instructions; what
 * goes in is the message. Reported under `ignored` on the same terms as a
 * field the serving provider cannot honour — accepted, set aside, and said.
 */
const STEER_IGNORED: readonly (readonly [keyof ArtemisChatExtensions, string])[] = [
  ['systemPrompt', 'artemis.systemPrompt'],
  ['alwaysOnSkills', 'artemis.alwaysOnSkills'],
  ['permissionMode', 'artemis.permissionMode'],
  ['thinking', 'artemis.thinking'],
  ['fastMode', 'artemis.fastMode'],
  ['ultracode', 'artemis.ultracode'],
  ['chromeBrowser', 'artemis.chromeBrowser'],
  // A live run's browser tool set is fixed when it starts, exactly as its
  // Chrome is: the servers were built and handed to the provider, and a steer
  // arrives after that.
  ['extensionBrowser', 'artemis.extensionBrowser'],
];

/**
 * The slash commands the account behind a route would offer.
 *
 * Only ever used to lift one to the front of a prompt that put it elsewhere —
 * see `hoistSlashCommand`. `undefined` is "do not lift", which is what a build
 * that cannot enumerate commands and a host that failed to answer both get: a
 * prompt left exactly as it was sent is the honest degradation, and it is what
 * every client saw before this existed.
 *
 * The host caches this per account and directory and shares in-flight reads,
 * so asking on every turn costs one CLI per cache window rather than per turn.
 */
async function commandsBehind(
  context: ServerContext,
  model: ServerModel,
  cwd: string | undefined,
): Promise<readonly string[] | undefined> {
  const source = context.commands;
  if (source === undefined) return undefined;
  return source
    .list({
      profileId: String(model.profileId),
      providerId: model.providerId,
      ...(cwd === undefined ? {} : { cwd }),
    })
    .catch(() => undefined);
}

/**
 * Send a completions caller's message into the run already serving its
 * conversation, and answer with that run's stream.
 *
 * Ownership first, on the one rule the run surface has: a run belongs to the
 * connection that started it. A run the provider started on its own has no
 * such connection, and the resume gate has already proven this caller owns
 * the conversation it is in — so the claim is made here, idempotently, and a
 * run another connection already holds is refused rather than shared. The
 * caller is then attached exactly as a client picking a lost stream back up
 * is, deadlines and all, and its request's `artemis` fields ride the reply as
 * the run's do.
 *
 * `409` throughout, and never a fork: a fork or a rewind reshapes a
 * conversation that is mid-sentence, and a build with no directory cannot say
 * whose the run is. Both are told to wait or stop the turn, which is the
 * truth, and neither is quietly turned into a second run — which is the whole
 * failure this exists to end.
 */
async function steerLiveRun(input: {
  readonly context: ServerContext;
  readonly connection: ServerConnection;
  readonly request: ServerRequestInfo;
  readonly chat: OpenAiChatRequest;
  readonly extensions: ArtemisChatExtensions;
  readonly model: ServerModel;
  readonly live: RunHandle;
  readonly ignored: readonly string[];
  readonly redirected?: RouteRedirect;
}): Promise<ServerReply | ServerStreamReply> {
  const { context, connection, extensions, model, live } = input;
  const runs = context.runs;
  const directory = context.runDirectory;
  const busy = (detail: string): ServerReply =>
    fail(409, 'invalid_request_error', 'session_busy', detail);

  if (extensions.forkSession === true || extensions.rewindToMessageId !== undefined) {
    return busy(
      'This conversation is still working on its last message. Stop it before forking or rewinding it.',
    );
  }
  if (runs === undefined || runs.send === undefined || directory === undefined) {
    return busy(
      'This conversation is still working on its last message. Wait for it to finish, or stop it, before sending another.',
    );
  }

  directory.claim({
    runId: live.runId,
    connectionId: connection.id,
    permissions: extensions.remote?.permissions === true,
    route: model.route,
  });
  if (!directory.owns(connection.id, live.runId)) {
    return busy(
      'This conversation is being driven from another connection. Wait for that turn to finish before sending another.',
    );
  }
  directory.noteSeen(live.runId);
  directory.noteAttached(live.runId);

  const ignored = [
    ...input.ignored,
    ...STEER_IGNORED.filter(([field]) => extensions[field] !== undefined).map(([, name]) => name),
  ];
  // The workspace the live run is in, so the command list is the one a turn
  // there would really see; a connection without a directory gets the host's
  // own substitution.
  const steerCommands = await commandsBehind(
    context,
    model,
    connection.workspace.kind === 'directory' ? connection.workspace.path : undefined,
  );
  const steer: SteerRequest = {
    runId: live.runId,
    prompt: promptFromMessages(input.chat.messages, {
      resuming: true,
      ...(steerCommands === undefined ? {} : { commands: steerCommands }),
    }),
    // Already read, merged and refused-if-unsupported by the route above; a
    // steer into a live run stages them beside what its opening prompt staged.
    ...(extensions.attachments === undefined ? {} : { attachments: extensions.attachments }),
    ...(extensions.sessionId === undefined ? {} : { sessionId: extensions.sessionId }),
    ...(input.request.signal === undefined ? {} : { signal: input.request.signal }),
    onDetach: (id: RunId) => directory.noteDetached(id),
  };
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
  const created = Math.floor(Date.now() / 1000);

  if (input.chat.stream === true) {
    return {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
      connectionId: connection.id,
      stream: streamSteer({
        id,
        created,
        model,
        runs,
        request: steer,
        ignored,
        ...(input.redirected === undefined ? {} : { redirected: input.redirected }),
        heartbeatMs: context.remoteStream?.heartbeatMs ?? DEFAULT_COMPLETIONS_HEARTBEAT_MS,
      }),
    };
  }

  let result: TurnResult | undefined;
  try {
    for await (const event of steerTurn(runs, steer)) {
      if (event.kind === 'done') result = event.result;
    }
  } catch (error) {
    return fail(
      502,
      'server_error',
      'run_failed',
      error instanceof Error ? error.message : 'The message could not be sent into the running turn.',
    );
  }
  if (result === undefined) {
    return fail(502, 'server_error', 'no_result', 'The run ended without producing a reply.');
  }
  if (result.error !== undefined && result.text.length === 0) {
    return fail(502, 'server_error', 'run_failed', result.error);
  }
  return {
    status: 200,
    headers: { ...JSON_HEADERS, ...CORS_HEADERS },
    body: chatResponse({
      id,
      model: model.route,
      created,
      result,
      ignored,
      ...(input.redirected === undefined ? {} : { redirected: input.redirected }),
      ...(model.resolvedModel === undefined ? {} : { resolvedModel: model.resolvedModel }),
    }),
  };
}

/**
 * A steered run's stream: the role chunk a fresh turn opens with — this
 * caller has no message open yet — then the run picked up from the start.
 */
async function* streamSteer(input: {
  readonly id: string;
  readonly created: number;
  readonly model: ServerModel;
  readonly runs: RunSource;
  readonly request: SteerRequest;
  readonly ignored: readonly string[];
  readonly redirected?: RouteRedirect;
  readonly heartbeatMs: number;
}): AsyncIterable<string> {
  const frame: ChunkFrame = { id: input.id, model: input.model.route, created: input.created };
  const { ignored, redirected } = input;
  yield sseEvent(
    chatChunk({
      ...frame,
      delta: { role: 'assistant' },
      ...(ignored.length === 0 && redirected === undefined
        ? {}
        : {
            artemis: {
              ...(ignored.length === 0 ? {} : { ignored }),
              ...(redirected === undefined ? {} : { redirected }),
            },
          }),
    }),
  );
  try {
    for await (const item of paced(steerTurn(input.runs, input.request), input.heartbeatMs)) {
      if (item === HEARTBEAT) {
        yield SSE_HEARTBEAT;
        continue;
      }
      const chunk = chunkFor(item, frame, {});
      if (chunk !== undefined) yield sseEvent(chunk);
    }
  } catch (error) {
    yield sseEvent(failureChunk(frame, error));
  }
  yield sseEvent(SSE_DONE);
}

/**
 * A run's completions stream, picked back up after its cursor.
 *
 * No role chunk: the client that asks for this already has the message open
 * and is appending to it. Otherwise the same bytes the original stream would
 * have carried, from the same translation, with the same heartbeat — and the
 * same sentinel at the end, so a client can tell "the run is over" from "the
 * socket died again".
 */
async function* streamResume(input: {
  readonly id: string;
  readonly created: number;
  readonly route: string;
  readonly runs: RunSource;
  readonly request: ResumeRequest;
  readonly heartbeatMs: number;
}): AsyncIterable<string> {
  const frame: ChunkFrame = { id: input.id, model: input.route, created: input.created };
  try {
    for await (const item of paced(resumeTurn(input.runs, input.request), input.heartbeatMs)) {
      if (item === HEARTBEAT) {
        yield SSE_HEARTBEAT;
        continue;
      }
      const chunk = chunkFor(item, frame, {});
      if (chunk !== undefined) yield sseEvent(chunk);
    }
  } catch (error) {
    yield sseEvent(failureChunk(frame, error));
  }
  yield sseEvent(SSE_DONE);
}
