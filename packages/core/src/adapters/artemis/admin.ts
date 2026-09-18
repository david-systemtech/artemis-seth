/**
 * Administering a *remote* Artemis: adding an account, and signing it in.
 * ============================================================================
 *
 * `adapter.ts` is this Artemis driving another one's *runs*. This is the small
 * second half: driving the other one's **accounts**, which is what makes a
 * headless server usable without a shell inside it. The routes are documented
 * on the server side in `protocol/src/server.ts`; what lives here is the
 * client, reusing the adapter's own address and token derivation so that a
 * profile which can run a turn can also administer the server it runs on.
 *
 * ## Why this is here rather than in the SDK
 *
 * The published SDK has the same six calls, and a program outside Artemis
 * should use those. The desktop app cannot: `@rx-artemis/core` is what the main
 * process already depends on, and reaching for a second package to make six
 * `fetch` calls against an address this module already knows how to compose
 * would be a dependency bought for nothing. The two are kept honest by both
 * being typed against the protocol's own bodies — neither redeclares a shape.
 *
 * ## What crosses this wire
 *
 * A label, a verification URL and a code the user typed. No credential, in
 * either direction: the provider's CLI writes its own token into its own config
 * directory on the *server's* machine, and nothing here reads it.
 */

import type { ServerUsageBody } from '@rx-artemis/protocol';
import type {
  ProfileId,
  RoutineDraft,
  RoutinePatch,
  ServerProfile,
  ServerProfileCreatedBody,
  ServerProfilesBody,
  ServerMemoryBank,
  ServerMemoryBankAccount,
  ServerMemoryBankBody,
  ServerMemoryBankScope,
  ServerMemoryBanksBody,
  ServerRoutineBody,
  ServerRoutineDeletedBody,
  ServerRoutinesBody,
  ServerSignInStatus,
} from '@rx-artemis/protocol';
import { SERVER_API_VERSION } from '@rx-artemis/protocol';

import { adapterError, isAdapterError } from '../types.js';
import { artemisAuthHeaders, artemisEndpoint, ARTEMIS_PROVIDER_ID } from './adapter.js';

/*
 * Re-exported here because this is the module a *host* imports.
 *
 * The adapter itself is reached through the registry like every other
 * provider's, so its id has never needed to be public; a caller of these
 * functions does need it, to refuse a profile that names some other provider
 * before sending its request to whatever address that profile happens to hold.
 */
export { ARTEMIS_PROVIDER_ID };

const API_PREFIX = `/api/${SERVER_API_VERSION}`;

/** The environment an Artemis profile resolves to: an address and a token. */
export type ArtemisProfileEnv = Readonly<Record<string, string | undefined>>;

/**
 * What a client needs before it can offer to add an account.
 *
 * Two answers in one round trip, because they are one question on screen: may
 * I show this at all, and what is already here? Fetching them separately would
 * let a pane render an "Add account" button a moment before learning it had no
 * authority to use it.
 */
export interface RemoteAccounts {
  /** The serving connection carries the administrative grant. */
  readonly manageProfiles: boolean;
  /** Every account this connection can see, with its models. */
  readonly profiles: readonly ServerProfile[];
}

/**
 * Everything the accounts pane needs for its first paint.
 *
 * The connection read is the authority; the profile read is the content. A
 * connection *without* the grant still gets its profiles — that list is the
 * ordinary catalogue every client may read — so a pane can show what is on the
 * server while hiding the controls that change it.
 */
export async function readRemoteAccounts(
  env: ArtemisProfileEnv,
  options?: { readonly signal?: AbortSignal },
): Promise<RemoteAccounts> {
  const [connection, profiles] = await Promise.all([
    call<{ manageProfiles?: unknown }>(env, `${API_PREFIX}/connection`, options),
    call<ServerProfilesBody>(env, `${API_PREFIX}/profiles`, options),
  ]);
  return {
    // `=== true` because an older server sends nothing here, and a missing
    // field must land as "no" rather than as an administrative surface a
    // client offers and the server then 404s.
    manageProfiles: connection.manageProfiles === true,
    profiles: Array.isArray(profiles.profiles) ? profiles.profiles : [],
  };
}

/** Add an account to the server. */
export async function createRemoteAccount(
  env: ArtemisProfileEnv,
  request: { readonly label: string; readonly provider?: string },
  options?: { readonly signal?: AbortSignal },
): Promise<ServerProfileCreatedBody> {
  return call<ServerProfileCreatedBody>(env, `${API_PREFIX}/profiles`, options, {
    method: 'POST',
    body: request,
  });
}

/**
 * The server's gauges: one row per visible account with a plan to read.
 *
 * What the desktop's poller fans out into per-account pushes — same
 * `PlanUsage` shape a local profile's reading has, the serving host's cache
 * deciding freshness.
 */
export async function readRemoteUsage(
  env: ArtemisProfileEnv,
  options?: { readonly signal?: AbortSignal },
): Promise<ServerUsageBody> {
  return call<ServerUsageBody>(env, `${API_PREFIX}/usage`, options);
}

/** Change one account: label, endpoint address, key — any subset. */
export async function updateRemoteAccount(
  env: ArtemisProfileEnv,
  accountId: string,
  patch: { readonly label?: string; readonly baseUrl?: string; readonly apiKey?: string },
  options?: { readonly signal?: AbortSignal },
): Promise<ServerProfileCreatedBody> {
  return call<ServerProfileCreatedBody>(
    env,
    `${API_PREFIX}/profiles/${encodeURIComponent(accountId)}`,
    options,
    { method: 'PATCH', body: patch },
  );
}

/** The server's memory banks as a client has to meet them. */
export interface RemoteMemoryBanks {
  /**
   * This profile's token was granted account administration, which is the same
   * grant that scopes a bank. False is the ordinary answer for a token pasted
   * from `connection create` without `--manage-profiles`.
   */
  readonly manageProfiles: boolean;
  /**
   * The server answers this surface at all.
   *
   * False for a server too old to have the routes and for one that keeps no
   * registry — which the wire cannot tell apart, by design, and which a client
   * has no reason to: both mean there is nothing here to edit. Distinct from
   * `manageProfiles` because the sentences a pane should show differ: "this
   * server cannot" against "this token may not".
   */
  readonly available: boolean;
  readonly banks: readonly ServerMemoryBank[];
  /** The accounts a scope may name, for the checklist. */
  readonly profiles: readonly ServerMemoryBankAccount[];
}

/**
 * The server's memory banks, the accounts a scope may name, and whether this
 * token may change either.
 *
 * Shaped like {@link readRemoteAccounts} and for the same reason: a pane needs
 * the grant and the rows together or it will render controls it cannot use.
 * The banks read is allowed to be absent — a 404 is what both an older server
 * and an unprivileged token get, and neither is an error worth a banner.
 */
export async function readRemoteMemoryBanks(
  env: ArtemisProfileEnv,
  options?: { readonly signal?: AbortSignal },
): Promise<RemoteMemoryBanks> {
  const [connection, banks] = await Promise.all([
    call<{ manageProfiles?: unknown }>(env, `${API_PREFIX}/connection`, options),
    absentOnUnavailable(
      call<ServerMemoryBanksBody>(env, `${API_PREFIX}/memory-banks`, options),
    ),
  ]);
  return {
    manageProfiles: connection.manageProfiles === true,
    available: banks !== null,
    banks: Array.isArray(banks?.banks) ? banks.banks : [],
    profiles: Array.isArray(banks?.profiles) ? banks.profiles : [],
  };
}

/**
 * Choose which of the server's accounts one of its banks reaches.
 *
 * The scope is sent whole rather than as a diff — the same shape the desktop
 * stores for its own banks — so a client that has just drawn a checklist sends
 * what the checklist says, and two clients editing at once do not interleave
 * into a scope neither asked for.
 */
export async function setRemoteMemoryBankScope(
  env: ArtemisProfileEnv,
  slug: string,
  profiles: ServerMemoryBankScope,
  options?: { readonly signal?: AbortSignal },
): Promise<ServerMemoryBankBody> {
  return call<ServerMemoryBankBody>(
    env,
    `${API_PREFIX}/memory-banks/${encodeURIComponent(slug)}`,
    options,
    { method: 'PATCH', body: { profiles } },
  );
}

/** Remove one account. The server keeps the directory; see the route's contract. */
export async function deleteRemoteAccount(
  env: ArtemisProfileEnv,
  accountId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<{ readonly removed: boolean }> {
  return call<{ readonly removed: boolean }>(
    env,
    `${API_PREFIX}/profiles/${encodeURIComponent(accountId)}`,
    options,
    { method: 'DELETE' },
  );
}

/** Spawn the provider's login for one account on the server. */
export async function startRemoteSignIn(
  env: ArtemisProfileEnv,
  accountId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ServerSignInStatus> {
  return call<ServerSignInStatus>(env, signInPath(accountId), options, { method: 'POST' });
}

/**
 * Where the sign-in has got to, or `null` when there is none.
 *
 * `null` rather than a throw for the 404, because this is polled every second
 * or two while a person reads their email, and "nobody has started one" is an
 * ordinary answer rather than a failure.
 */
export async function readRemoteSignIn(
  env: ArtemisProfileEnv,
  accountId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ServerSignInStatus | null> {
  return absentOnMissing(call<ServerSignInStatus>(env, signInPath(accountId), options));
}

/** Hand the CLI the code the user pasted. */
export async function submitRemoteSignInCode(
  env: ArtemisProfileEnv,
  accountId: string,
  code: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ServerSignInStatus> {
  return call<ServerSignInStatus>(env, `${signInPath(accountId)}/code`, options, {
    method: 'POST',
    body: { code },
  });
}

/** Kill the login subprocess. `null` when there was nothing to kill. */
export async function cancelRemoteSignIn(
  env: ArtemisProfileEnv,
  accountId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ServerSignInStatus | null> {
  return absentOnMissing(
    call<ServerSignInStatus>(env, signInPath(accountId), options, { method: 'DELETE' }),
  );
}

/* -------------------------------------------------------------------------- */
/* Routines that live on the server                                           */
/* -------------------------------------------------------------------------- */

/**
 * Driving a *remote* server's routines — the appointments that fire in the
 * server itself, with this desktop closed. The client half of the routes in
 * `server/routines.ts`, reusing the same address and token an ordinary run
 * against this profile is given: a profile that can run a turn on a server can
 * schedule one there too. Every call is scoped by the server to the connection
 * this profile's token names, so a client sees only its own routines.
 */

/** Every routine this connection owns on the server. */
export async function listRemoteRoutines(
  env: ArtemisProfileEnv,
  options?: { readonly signal?: AbortSignal },
): Promise<ServerRoutinesBody> {
  return call<ServerRoutinesBody>(env, `${API_PREFIX}/routines`, options);
}

/** Create a routine on the server. Its directory is the connection's — see the route. */
export async function createRemoteRoutine(
  env: ArtemisProfileEnv,
  draft: RoutineDraft,
  options?: { readonly signal?: AbortSignal },
): Promise<ServerRoutineBody> {
  return call<ServerRoutineBody>(env, `${API_PREFIX}/routines`, options, {
    method: 'POST',
    body: { draft },
  });
}

/** Edit a routine on the server. Absent fields are left alone. */
export async function updateRemoteRoutine(
  env: ArtemisProfileEnv,
  routineId: string,
  patch: RoutinePatch,
  options?: { readonly signal?: AbortSignal },
): Promise<ServerRoutineBody> {
  return call<ServerRoutineBody>(
    env,
    `${API_PREFIX}/routines/${encodeURIComponent(routineId)}`,
    options,
    { method: 'PATCH', body: { patch } },
  );
}

/** Delete a routine on the server. */
export async function deleteRemoteRoutine(
  env: ArtemisProfileEnv,
  routineId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ServerRoutineDeletedBody> {
  return call<ServerRoutineDeletedBody>(
    env,
    `${API_PREFIX}/routines/${encodeURIComponent(routineId)}`,
    options,
    { method: 'DELETE' },
  );
}

/** Fire a routine on the server now, schedule and pause notwithstanding. */
export async function runRemoteRoutine(
  env: ArtemisProfileEnv,
  routineId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ServerRoutineBody> {
  return call<ServerRoutineBody>(
    env,
    `${API_PREFIX}/routines/${encodeURIComponent(routineId)}/run-now`,
    options,
    { method: 'POST' },
  );
}

/** An account id is opaque and may be anything the server minted. Encode it. */
function signInPath(accountId: ProfileId | string): string {
  return `${API_PREFIX}/profiles/${encodeURIComponent(String(accountId))}/signin`;
}

/**
 * `null` for a surface this server does not offer.
 *
 * {@link absentOnMissing}'s 404 plus the `501` a build that serves accounts but
 * keeps no memory-bank registry answers. Both are "nothing to show here" and
 * neither is worth an error in a pane the user merely opened.
 */
async function absentOnUnavailable<T>(pending: Promise<T>): Promise<T | null> {
  try {
    return await pending;
  } catch (error) {
    if (!isAdapterError(error)) throw error;
    const status = error.agentError.httpStatus;
    if (status === 404 || status === 501) return null;
    throw error;
  }
}

async function absentOnMissing<T>(pending: Promise<T>): Promise<T | null> {
  try {
    return await pending;
  } catch (error) {
    // 404 is both "no flow here" and "your connection may not ask", and the
    // server refuses to distinguish them on purpose. Either way there is
    // nothing to show, which is what `null` says.
    if (isAdapterError(error) && error.agentError.httpStatus === 404) return null;
    throw error;
  }
}

/**
 * One request to the serving Artemis, with its refusal turned into something
 * the UI can print.
 *
 * The server's own `error.message` is passed through, and that is right here
 * where it is not elsewhere: these routes are reached only by a connection the
 * operator granted administration, every message they produce is about
 * *this* caller's own request, and the alternative — a generic sentence — would
 * leave a person staring at "the request failed" with a duplicate label they
 * cannot see.
 */
async function call<T>(
  env: ArtemisProfileEnv,
  path: string,
  options?: { readonly signal?: AbortSignal },
  write?: { readonly method: string; readonly body?: unknown },
): Promise<T> {
  const root = artemisEndpoint(env);
  let response: Response;
  try {
    response = await fetch(`${root}${path}`, {
      ...(write === undefined ? {} : { method: write.method }),
      headers: {
        accept: 'application/json',
        ...artemisAuthHeaders(env),
        ...(write?.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(write?.body === undefined ? {} : { body: JSON.stringify(write.body) }),
      // Generous, because a `POST …/signin` spawns a process on the far side
      // and the reply waits for it to say something. Not unbounded: a tunnel
      // that has gone away must not hang a pane forever.
      signal: options?.signal ?? AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    throw adapterError(
      'network',
      `Could not reach the Artemis server at ${root}. Is it running, and is its address reachable from this machine?`,
      { retryable: true, cause },
    );
  }

  if (!response.ok) throw await refusal(response, root);
  return (await response.json()) as T;
}

/**
 * Turn a failed response into an error that still carries its status.
 *
 * `httpStatus` is filled in because one caller branches on it —
 * `absentOnMissing`, for the 404 that means "nothing here" — and matching on
 * the message would be matching on prose the server is free to reword.
 */
async function refusal(response: Response, root: string): Promise<Error> {
  let message: string | undefined;
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === 'string') message = body.error.message;
  } catch {
    // Not JSON, or no body. The status still says something true.
  }

  return adapterError(
    response.status === 401 || response.status === 403
      ? 'auth'
      : response.status >= 500
        ? 'provider_unavailable'
        : 'invalid_request',
    message ??
      (response.status === 404
        ? 'That account surface is not available on this server.'
        : `The Artemis server at ${root} answered ${String(response.status)}.`),
    { httpStatus: response.status },
  );
}
