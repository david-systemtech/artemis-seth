/**
 * The offer that appears when this account runs out of plan.
 * ============================================================================
 *
 * A turn that dies on a rejected window leaves everything the agent had worked
 * out implicit in a transcript nobody reads back, and the terminal is the one
 * agent front end with somewhere else to put the work: a second account, and
 * often a shared `projects/` store that the second account can read the very
 * same conversation out of. So when the provider stops serving, the line under
 * the composer stops being a status and becomes an offer.
 *
 * ADR 0003 decides the shape of it, and every function here is written to that
 * decision: **a hand off is a chosen act**. Nothing in this module moves a
 * conversation. It answers three questions and hands the answers to a picker —
 * has something happened worth offering a move over ({@link failoverReason}),
 * which accounts could take it and which cannot and why
 * ({@link failoverCandidates}), and what the one line under the composer says
 * about both ({@link failoverLine}). The keystroke and the picker are in
 * `app.tsx`; the move itself is the user's.
 *
 * ## The judgements are borrowed, not invented
 *
 * Every verdict here already exists somewhere with a reason written under it,
 * and the whole point of this file is to spend none of that reasoning twice:
 *
 *  - **What counts as out** is `bindingWindow`'s rejected verdict — the
 *    provider saying what it is doing with requests right now, which outranks
 *    any percentage. A rejected window at 97% is out, not "3% from out".
 *  - **What counts as nearly out** is `handoffTrigger` against
 *    `DEFAULT_HANDOFF_THRESHOLDS` — 90% of the 5-hour window, 98% of the week,
 *    95% of Fable's bucket — so the terminal and the desktop hand off at the
 *    same moment rather than at two numbers that happen to be near each other.
 *  - **What counts as a reading worth acting on** is `PLAN_USAGE_MAX_AGE_MS`,
 *    the desktop's six minutes. A reading three polls old may describe an
 *    account another machine has since drained.
 *  - **Which windows have names** is `planMeterSlots` for the short ones the
 *    meter draws (`5hr`, `Week`, `Fable`) and the threshold labels for the
 *    long ones a sentence needs (`5-hour`, `weekly`, `Fable`). Two surfaces
 *    naming one window differently is how a person ends up believing there are
 *    four limits.
 *
 * The one judgement that is deliberately *not* made here is a ranking of fit.
 * `bindingWindow` is workload-blind and `drain-v1` is unimplemented, so the
 * least-loaded account is named as a starting point and never as a
 * recommendation — which is exactly why the line names one and the picker
 * shows all of them.
 *
 * ## Freshness cuts one way only
 *
 * A stale reading suppresses `near` and never suppresses `rejected`. The
 * threshold is a forecast made from a percentage, and a percentage that is
 * seven minutes old forecasts nothing; the verdict is the provider's own
 * report of what it is doing, and age does not make a refusal less true. The
 * same asymmetry is why a rejected window still prints `out` on the meter
 * while its percentage goes dim.
 *
 * ## Nothing is hidden
 *
 * A blocked account keeps its row, disabled, with the reason in words — the
 * desktop's `GatedItem` rule, and the profile picker's already. An account
 * that vanishes from a list at the moment the user needs it is an account they
 * conclude was taken away, and the reason is usually a thing they could fix in
 * a minute if anybody told them what it was.
 */

import {
  DEFAULT_HANDOFF_THRESHOLDS,
  PLAN_USAGE_MAX_AGE_MS,
  bindingWindow,
  handoffTrigger,
  planMeterSlots,
  windowFor,
  type HandoffThreshold,
  type PlanUsage,
  type PlanUsageWindow,
  type ProfileMetadata,
  type ServerProfile,
} from '@rx-artemis/protocol';

/**
 * Why the offer is on the line.
 *
 * Two kinds, because they are two different sentences and two different
 * decisions: `rejected` is "this has already stopped you and here is when it
 * comes back", `near` is "this is about to, and you can still spend the last
 * of it writing something down". The window is carried under both names it has
 * — the meter's short one for the line and the threshold's long one for a
 * sentence — so neither surface has to translate the other's.
 */
export interface FailoverReason {
  readonly kind: 'rejected' | 'near';
  /** The window as the meters draw it: `5hr`, `Week`, `Fable`. */
  readonly window: string;
  /** The same window in a sentence: `5-hour`, `weekly`, `Fable`. */
  readonly windowInWords: string;
  /** Percent full, rounded. Absent only when the provider reported no number. */
  readonly utilization?: number;
  /** When the window rolls over. Absent when the provider does not say. */
  readonly resetsAt?: number;
}

/**
 * Why an account cannot take the work, or `null` when it can.
 *
 * The sentence *is* the value: these go straight onto a disabled picker row,
 * and a code that had to be translated somewhere else would be one more place
 * for the two to drift apart.
 */
export type FailoverBlock =
  | 'signed out'
  | 'unavailable'
  | 'rejected'
  | 'stale reading'
  | 'cannot reach this conversation';

/** One account the offer lists, whether or not it can be chosen. */
export interface FailoverCandidate {
  readonly id: string;
  readonly label: string;
  readonly providerLabel: string;
  /** `null` is "this account may take the work". */
  readonly block: FailoverBlock | null;
  /** Every window it is metered on, as the meters name them: `5hr 12% · Week 40%`. */
  readonly pressure?: string;
  /**
   * The binding window's percentage — what orders the rows and what the line
   * names. Absent when there is no reading to answer from, which is a
   * different thing from zero.
   */
  readonly load?: number;
}

/**
 * Wall-clock time, in the shape the reset is worth reading in.
 *
 * `describeReset`'s rule — lead with the clock rather than "in 4h", because a
 * duration needs arithmetic before anyone can decide whether to wait or move —
 * and `formatClock`'s 24-hour convention minus the seconds, which on a reset
 * an hour away are noise. `h23` rather than `hour12: false` because the latter
 * prints `24:05` for five past midnight under some locales.
 */
export function resetClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
}

const percent = (value: number): string => `${String(Math.round(value))}%`;

/**
 * The long name for a window, taken from whichever threshold rule is about it.
 *
 * Asked of `windowFor` rather than matched on the id here, because the
 * per-model buckets a plan meters separately are spelled differently on
 * different accounts and that matching is the thing `windowFor` exists to do.
 * A window no rule is about keeps the provider's own label.
 */
function inWords(
  usage: PlanUsage,
  window: PlanUsageWindow,
  thresholds: readonly HandoffThreshold[],
): string {
  for (const threshold of thresholds) {
    if (windowFor(usage, threshold)?.id === window.id) return threshold.label;
  }
  return window.label;
}

/** The short name, as the meter under the composer draws it. */
function inMeter(usage: PlanUsage, window: PlanUsageWindow): string {
  return planMeterSlots(usage).find((slot) => slot.window.id === window.id)?.label ?? window.label;
}

/**
 * Whether this reading is worth making a claim about *right now* from.
 *
 * The desktop's `actionable`, to the same bar and for the same reason. Kept as
 * its own predicate because {@link failoverReason} applies it to one of its two
 * kinds and {@link failoverCandidates} applies it to every account.
 */
function fresh(usage: PlanUsage | null | undefined, now: number): boolean {
  if (!usage?.available) return false;
  return now - usage.fetchedAt <= PLAN_USAGE_MAX_AGE_MS;
}

/**
 * Is there anything to offer a hand off over, and what.
 *
 * `null` almost always, which is the point: this is asked on every render of
 * the status bar, and the offer has to disappear on its own the moment the
 * window rolls or a fresher reading lands. Nothing switches the line off — it
 * simply stops being true.
 */
export function failoverReason(
  usage: PlanUsage | null | undefined,
  now = Date.now(),
  thresholds: readonly HandoffThreshold[] = DEFAULT_HANDOFF_THRESHOLDS,
): FailoverReason | null {
  if (!usage?.available) return null;

  /*
   * The verdict first, and without the freshness bar. `bindingWindow` already
   * prefers a rejected window over any percentage and picks the worst of
   * several, so asking it is both the right question and the one the meter
   * beside this line is drawn from.
   */
  const binding = bindingWindow(usage);
  if (binding !== null && binding.status === 'rejected') {
    return {
      kind: 'rejected',
      window: inMeter(usage, binding),
      windowInWords: inWords(usage, binding, thresholds),
      ...(binding.utilization === null ? {} : { utilization: Math.round(binding.utilization) }),
      ...(binding.resetsAt === null ? {} : { resetsAt: binding.resetsAt }),
    };
  }

  // A forecast made from a percentage nobody has refreshed in six minutes is
  // not a forecast. See the header.
  if (!fresh(usage, now)) return null;

  const trigger = handoffTrigger(usage, thresholds);
  if (trigger === null) return null;
  return {
    kind: 'near',
    window: inMeter(usage, trigger.window),
    windowInWords: trigger.threshold.label,
    utilization: trigger.utilization,
    ...(trigger.window.resetsAt === null ? {} : { resetsAt: trigger.window.resetsAt }),
  };
}

/** Every window an account is metered on, in the meter's own vocabulary. */
function pressureOf(usage: PlanUsage | null | undefined): string | undefined {
  const slots = planMeterSlots(usage);
  if (slots.length === 0) return undefined;
  return slots
    .map((slot) => {
      const { utilization, status } = slot.window;
      if (status === 'rejected') return `${slot.label} out`;
      return `${slot.label} ${utilization === null ? '—' : percent(utilization)}`;
    })
    .join(' · ');
}

/** How full the window that would stop this account is, 0–100. */
function loadOf(usage: PlanUsage | null | undefined): number | undefined {
  const binding = bindingWindow(usage);
  if (binding === null) return undefined;
  // A rejected window is full whatever its stale percentage reads — the same
  // correction `planHeadroom` makes at the other end of the same arithmetic.
  if (binding.status === 'rejected') return 100;
  return binding.utilization === null ? undefined : binding.utilization;
}

/**
 * Why this account cannot be chosen, or `null`.
 *
 * Order runs from the most structural fact to the most momentary, and where
 * several are true the most structural one wins the sentence. Two placements
 * are load-bearing rather than arbitrary:
 *
 *  - **`rejected` above `cannot reach`**, so an account that is itself out is
 *    never offered a fresh start it could not serve either.
 *  - **`cannot reach` above `stale reading`**, because the unreachable row is
 *    what the "start fresh on …" offer hangs off, and an account that cannot
 *    be handed the *conversation* can still be handed the *work*. Withholding
 *    that over a reading that is merely old would close the one door left at
 *    a provider boundary.
 */
function blockFor(args: {
  readonly row: ServerProfile;
  readonly meta: ProfileMetadata | undefined;
  readonly usage: PlanUsage | null | undefined;
  readonly reachable: boolean;
  readonly now: number;
}): FailoverBlock | null {
  const { row, meta, usage, reachable, now } = args;
  // No metadata is an account the catalogue lists and this machine does not
  // configure; a stored key is one only the desktop can read. Both are the
  // same answer to the same question — nothing can be run as this account
  // from here — so both wear the same word.
  if (meta === undefined || row.disabled || !row.available || meta.hasApiKey === true) return 'unavailable';
  if (row.auth?.loggedIn === false) return 'signed out';
  const binding = bindingWindow(usage);
  if (binding?.status === 'rejected') return 'rejected';
  if (!reachable) return 'cannot reach this conversation';
  /*
   * `available: false` is not a missing reading, it is a successful one saying
   * that plan limits do not apply here at all — an API key, Bedrock, Vertex.
   * An account that cannot run out is the safest place in the list to send
   * work, so the freshness bar below must not shut it out for having no
   * percentage to be fresh about.
   */
  if (usage?.available === false) return null;
  if (!fresh(usage, now)) return 'stale reading';
  return null;
}

/**
 * Every other account, with the facts, in the order the picker lists them.
 *
 * Chooseable ones first and emptiest first; the blocked ones after, in the
 * catalogue's own order. Sorting by load is the only ranking made anywhere in
 * this feature and it is presentation rather than advice — see the header on
 * why no recommendation is offered.
 */
export function failoverCandidates(
  catalogue: readonly ServerProfile[],
  metadata: readonly ProfileMetadata[],
  usageByProfile: ReadonlyMap<string, PlanUsage | null>,
  current: string,
  reachable: (profileId: string) => boolean,
  now = Date.now(),
): readonly FailoverCandidate[] {
  const keyed = new Map(metadata.map((profile) => [profile.id, profile]));
  const rows = catalogue
    .filter((row) => row.id !== current)
    .map((row): FailoverCandidate => {
      const { id } = row;
      const usage = usageByProfile.get(id) ?? null;
      const block = blockFor({ row, meta: keyed.get(id), usage, reachable: reachable(id), now });
      const pressure = pressureOf(usage);
      const load = loadOf(usage);
      return {
        id,
        label: row.label,
        providerLabel: row.provider.label,
        block,
        ...(pressure === undefined ? {} : { pressure }),
        ...(load === undefined ? {} : { load }),
      };
    });

  return [...rows].sort((a, b) => {
    if ((a.block === null) !== (b.block === null)) return a.block === null ? -1 : 1;
    if (a.block !== null) return 0;
    // An account with no number sorts behind every account with one: it cannot
    // be shown to have room, and the line names the first row it is handed.
    return (a.load ?? Number.POSITIVE_INFINITY) - (b.load ?? Number.POSITIVE_INFINITY);
  });
}

/** The account the line names: the emptiest one that may actually be chosen. */
export function bestFailoverCandidate(
  candidates: readonly FailoverCandidate[],
): FailoverCandidate | null {
  return candidates.find((candidate) => candidate.block === null) ?? null;
}

/**
 * The offer, as one line.
 *
 *     5hr window out · resets 14:30 · hand off to work (12%) · Ctrl+H
 *     5hr window out · resets 14:30 · no other account can take this · Ctrl+H
 *     5hr window at 94% · hand off to work (12%) · Ctrl+H
 *
 * Three decisions are visible in those three lines. The reset is printed for a
 * window that is *out* and not for one that is merely full, because on the
 * first it is the alternative to moving — wait until half two, or go now —
 * and on the second nothing is being waited for yet; the picker's title
 * carries it either way, which is one keystroke from here. The candidate is
 * named with its own number rather than with a verdict, because 12% is a fact
 * and "healthy" would be the ranking this feature does not make. And the line
 * says so plainly when there is nowhere to go: a dead-ended offer is worse
 * than none, and "no other account can take this" is at least the truth
 * somebody can act on by signing one in.
 *
 * A reset already in the past is dropped rather than printed. It means the
 * window has rolled and the verdict on the line is the last thing the provider
 * said rather than what it would say now — and `resets 14:30` read at three
 * o'clock is the sort of wrong that costs a surface its credibility.
 */
export function failoverLine(
  reason: FailoverReason,
  best: FailoverCandidate | null,
  now = Date.now(),
): string {
  const parts: string[] = [
    reason.kind === 'rejected'
      ? `${reason.window} window out`
      : reason.utilization === undefined
        ? `${reason.window} window near its limit`
        : `${reason.window} window at ${percent(reason.utilization)}`,
  ];
  if (reason.kind === 'rejected' && reason.resetsAt !== undefined && reason.resetsAt > now) {
    parts.push(`resets ${resetClock(reason.resetsAt)}`);
  }
  parts.push(
    best === null
      ? 'no other account can take this'
      : `hand off to ${best.label}${best.load === undefined ? '' : ` (${percent(best.load)})`}`,
  );
  parts.push('Ctrl+H');
  return parts.join(' · ');
}

/**
 * What the picker is titled: what happened, and the question it asks.
 *
 * The whole reason in one sentence, because a list of accounts with no subject
 * over it is a list nobody can answer — the user pressed a key that was on a
 * status line they may have read three minutes ago, and the title is where the
 * "why am I being asked this" goes.
 */
export function failoverTitle(reason: FailoverReason, now = Date.now()): string {
  const state =
    reason.kind === 'rejected'
      ? 'is out'
      : reason.utilization === undefined
        ? 'is near its limit'
        : `is at ${percent(reason.utilization)}`;
  const reset =
    reason.resetsAt !== undefined && reason.resetsAt > now ? `; it resets at ${resetClock(reason.resetsAt)}` : '';
  return `The ${reason.windowInWords} window ${state}${reset}. Where should this conversation go?`;
}

/** The last thing each side said, for {@link handoverBrief}. */
export interface HandoverParts {
  /** The newest prompt the person sent, or `null` when they have sent none. */
  readonly lastPrompt: string | null;
  /** The newest thing the agent said, or `null` when it has said nothing. */
  readonly lastReply: string | null;
}

/** How much of each turn a briefing carries before it stops being a briefing. */
const PROMPT_CHARS = 400;
const REPLY_CHARS = 600;

const flatten = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * The draft the composer is seeded with when the history cannot travel.
 *
 * A session id only resolves under a config directory that holds its
 * transcript, so the live move stops at the provider boundary — and ADR 0003's
 * answer to that is not to stop, it is to degrade. The account on the other
 * side can do the work given the briefing, and this is the briefing: the last
 * thing that was asked and the last thing that was said, which between them
 * are what a person would have typed out by hand anyway.
 *
 * Written by the app rather than asked of the agent, and deliberately. The
 * ADR's continuity note is a turn of the agent's own — it spends the last of a
 * spent account's budget to write down what it knows — and that is a different
 * feature from this one. This is two facts the transcript already holds,
 * assembled without a model, put in the box rather than sent, so the first act
 * on the new account is still the user's: they can send it, cut it down, or
 * type something else entirely over the top of it.
 */
export function handoverBrief(parts: HandoverParts): string {
  const sentences = ['Continuing from another account.'];
  if (parts.lastPrompt !== null && parts.lastPrompt.trim().length > 0) {
    sentences.push(`The last prompt was: ${flatten(parts.lastPrompt, PROMPT_CHARS)}`);
  }
  if (parts.lastReply !== null && parts.lastReply.trim().length > 0) {
    sentences.push(`The agent last said: ${flatten(parts.lastReply, REPLY_CHARS)}`);
  }
  return sentences.join('\n\n');
}
