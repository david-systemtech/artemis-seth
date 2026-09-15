/**
 * Where a stored conversation actually lives, and the resume that follows it.
 * ============================================================================
 *
 * A served conversation is held by exactly one account's store: the provider
 * writes each transcript under that profile's own config directory and, on a
 * resume, searches only that directory tree. The *request* to continue it
 * names an account too, through a model route — and nothing used to make the
 * two agree. A column left on some other account's route sent the resume
 * there, the provider answered `No conversation found with session ID`, the
 * run failed before its first token, and the ledger had already re-recorded
 * the session against the account that was about to fail to find it. The
 * next listing looked in that store, found nothing, and dropped the row. A
 * conversation vanished because the wrong account was selected, with its
 * transcript intact on disk the whole time.
 *
 * The rule here is the one the storage forces: **the account that holds the
 * transcript continues it.** A resume that names any other account is
 * redirected — the same model where the holding account offers it, its first
 * model otherwise — and the redirect is reported on the reply so a client can
 * say so. Refusing was the other honest answer, and it was rejected because
 * the client that sends the wrong account is, in every case seen, a column
 * left on a default rather than a person choosing to bill a different plan:
 * a refusal costs them the conversation until they work out why, a redirect
 * costs nothing and tells them.
 *
 * None of this runs on the ordinary path. When the ledger already names the
 * requested account there is no store read at all; the stores are consulted
 * only on a mismatch, and then in the order most likely to answer first —
 * the requested account (two profiles sharing a store answer here, and the
 * request stands), then the account the ledger names, then the rest.
 */

import type { ServerModel, ServerProfile } from '@rx-artemis/protocol';

import type { SessionSource } from './http.js';
import type { SessionLedger } from './ledger.js';

/**
 * A resume moved to the account that holds the conversation.
 *
 * Reported on the reply's `artemis` block — the first chunk of a stream, the
 * body of a whole response — so a client learns before the first token that
 * the run is not on the route it asked for. `from` and `to` are routes; the
 * profile fields name the account the run is actually on, in the terms the
 * catalogue uses.
 */
export interface RouteRedirect {
  readonly from: string;
  readonly to: string;
  readonly profileId: string;
  readonly profileSlug: string;
  readonly profileLabel: string;
}

/**
 * The first of `candidates` whose store holds `sessionId` under `cwd`.
 *
 * One listing read per candidate, stopping at the first hit. A store that
 * cannot be read is treated as not holding the conversation, which is the
 * only answer available and errs towards leaving the request as it was.
 */
export async function findSessionHome(
  sessions: SessionSource,
  candidates: readonly ServerProfile[],
  cwd: string,
  sessionId: string,
): Promise<ServerProfile | undefined> {
  for (const profile of candidates) {
    try {
      const page = await sessions.list({
        providerId: String(profile.provider.id),
        profileId: String(profile.id),
        cwd,
      });
      if (page.sessions.some((summary) => String(summary.id) === sessionId)) return profile;
    } catch {
      // Unreadable is "not here", as far as anyone can tell.
    }
  }
  return undefined;
}

/**
 * The stores to ask, in the order most likely to answer first.
 *
 * The requested account leads: two profiles pointed at one store both hold
 * the transcript, and the request should stand when it names either. The
 * account the ledger recorded comes next — where the conversation last ran
 * — and every other visible account after that, for the store that moved.
 */
export function homeCandidates(
  profiles: readonly ServerProfile[],
  requestedProfileId: string,
  recordedProfileId: string,
): readonly ServerProfile[] {
  const requested = profiles.find((profile) => String(profile.id) === requestedProfileId);
  const recorded = profiles.find((profile) => String(profile.id) === recordedProfileId);
  const rest = profiles.filter((profile) => profile !== requested && profile !== recorded);
  return [
    ...(requested === undefined ? [] : [requested]),
    ...(recorded === undefined || recorded === requested ? [] : [recorded]),
    ...rest,
  ];
}

/**
 * The model a completions resume actually runs on.
 *
 * `requested` unchanged whenever the ledger names its account, or has no
 * entry (the gate before this has already refused an id outside the caller's
 * scope, so an absent entry is a build with no ledger), or the requested
 * account's own store turns out to hold the transcript. Otherwise the model
 * on the holding account, with the redirect attached.
 */
export async function resolveResumeModel(input: {
  readonly sessions: SessionSource | undefined;
  readonly ledger: SessionLedger | undefined;
  readonly profiles: readonly ServerProfile[];
  readonly requested: ServerModel;
  readonly sessionId: string;
}): Promise<{ readonly model: ServerModel; readonly redirected?: RouteRedirect }> {
  const { sessions, ledger, profiles, requested, sessionId } = input;
  const requestedProfileId = String(requested.profileId);
  const home = await resolveHome({ sessions, ledger, profiles, requestedProfileId, sessionId });
  if (home === undefined) return { model: requested };

  const model = home.models.find((option) => option.id === requested.id) ?? home.models[0];
  // An account with no routable model cannot take the run; leaving the request
  // alone lets it fail with the provider's own message rather than a guess.
  if (model === undefined) return { model: requested };
  return {
    model,
    redirected: {
      from: requested.route,
      to: model.route,
      profileId: String(home.id),
      profileSlug: home.slug,
      profileLabel: home.label,
    },
  };
}

/**
 * The account a bridge-started resume actually runs on.
 *
 * The bridge names its account by profile id and its model by bare id, so the
 * redirect is expressed in those terms: the holding account's id, and the
 * same model id where that account offers it. Without one the model is left
 * unset, which is the bridge's spelling of "the provider's default".
 */
export async function resolveResumeProfile(input: {
  readonly sessions: SessionSource | undefined;
  readonly ledger: SessionLedger | undefined;
  readonly profiles: readonly ServerProfile[];
  readonly requestedProfileId: string;
  readonly requestedModel: string | undefined;
  readonly sessionId: string;
}): Promise<{
  readonly profileId: string;
  readonly model: string | undefined;
  readonly redirected?: { readonly from: string; readonly to: ServerProfile };
}> {
  const { requestedProfileId, requestedModel } = input;
  const home = await resolveHome(input);
  if (home === undefined) return { profileId: requestedProfileId, model: requestedModel };
  const kept =
    requestedModel !== undefined && home.models.some((option) => option.id === requestedModel);
  return {
    profileId: String(home.id),
    model: kept ? requestedModel : undefined,
    redirected: { from: requestedProfileId, to: home },
  };
}

/**
 * The account holding `sessionId`, when it is not the one requested.
 *
 * `undefined` means "leave the request alone": no ledger or store to ask, the
 * ledger already agrees, the requested account's store holds it too, or no
 * visible store holds it at all — in which last case the run will fail with
 * the provider's message, which is the truthful outcome for a transcript
 * that is genuinely gone.
 */
async function resolveHome(input: {
  readonly sessions: SessionSource | undefined;
  readonly ledger: SessionLedger | undefined;
  readonly profiles: readonly ServerProfile[];
  readonly requestedProfileId: string;
  readonly sessionId: string;
}): Promise<ServerProfile | undefined> {
  const { sessions, ledger, profiles, requestedProfileId, sessionId } = input;
  if (sessions === undefined || ledger === undefined) return undefined;
  const entry = ledger.get(sessionId);
  if (entry === undefined || entry.profileId === requestedProfileId) return undefined;

  const home = await findSessionHome(
    sessions,
    homeCandidates(profiles, requestedProfileId, entry.profileId),
    entry.cwd,
    sessionId,
  );
  if (home === undefined || String(home.id) === requestedProfileId) return undefined;
  return home;
}
