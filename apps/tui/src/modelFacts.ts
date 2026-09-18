/**
 * What the `/model` picker knows about the account it is picking on.
 * ============================================================================
 *
 * The terminal's model list is profile-blind. It offers Fable in the same ink
 * whether this account's Fable bucket is untouched or being refused outright,
 * so the only way to discover that the model you just chose cannot run is to
 * choose it and watch the turn die. The desktop's run navigator has not had
 * that problem since `modelFacts.ts`: every row there carries exhaustion,
 * pressure and the window that binds it. This is the same join for the
 * terminal — pure functions from a catalogue entry and a plan reading to the
 * three or four strings a `PickerItem` renders, and nothing else. No React, no
 * state, no I/O.
 *
 * ## The judgements are borrowed, not invented
 *
 * Nothing here decides anything that has already been decided somewhere with a
 * reason written under it. Two surfaces disagreeing about one account is worse
 * than either surface being silent:
 *
 *  - **Which window is about which model** is `handoff.ts`'s rule for a `model`
 *    threshold: a `model_scoped` window whose id or label mentions the model's
 *    name, worst bucket first. The per-model buckets are spelled differently on
 *    different accounts (`model_scoped:Fable` on one, a bare `model_scoped`
 *    with the name only in its label on another), which is exactly why the
 *    match is on names rather than ids.
 *  - **Which window stops you** is the protocol's own `bindingWindow`, asked
 *    over the windows that bind *this* model rather than over the whole plan.
 *    A rejected verdict outranks any percentage there, and that ranking is not
 *    worth a second implementation.
 *  - **What counts as pressure** is the desktop's `PlanUsageMeter.toneFor`:
 *    amber at 75, red at 90. Pessimistic on purpose — a window at 75% during a
 *    long session is worth noticing before it stops you, because the reset can
 *    be hours away — and shared with `StatusBar.meterTone` so a model is never
 *    calm in the picker and red on the bar two lines below it.
 *  - **What counts as a reading worth quoting** is `PLAN_USAGE_MAX_AGE_MS`,
 *    three missed polls, six minutes.
 *  - **What the windows are called** is `planMeterSlots` — `5hr`, `Week`,
 *    `Fable`, lowercased for a dim trailing detail — so the name in a row is
 *    the name on the meter under the composer.
 *
 * ## A model's own bucket answers for it; the account answers for the rest
 *
 * Exhaustion is read off the model's own weekly bucket when it has one, and off
 * the account's binding window only when it has none. That asymmetry is the
 * desktop's and it is deliberate: a plan that meters Fable apart from the total
 * can have Fable refused while everything else runs, and it can equally have
 * the 5-hour window refused while Fable's bucket sits at 10%. Disabling every
 * row on an account that is momentarily out would turn the picker into a wall
 * of struck-through text with nothing choosable in it, and the account being
 * out is the failover line's sentence to say, not this one's. So a row is
 * disabled only when the thing being refused is the row itself.
 *
 * Pressure asks the wider question, because it is a warning rather than a
 * verdict: the worst of the windows that bind this model — every shared window,
 * plus its own bucket. Other models' buckets are excluded, for the reason the
 * desktop gives: a full Opus bucket is no reason to tint the Sonnet row.
 *
 * ## Freshness cuts one way only
 *
 * A stale reading suppresses pressure and never suppresses exhaustion, the same
 * asymmetry `failover.ts` is built on. Pressure is a forecast made from a
 * percentage, and a percentage nobody has refreshed in six minutes forecasts
 * nothing — so it says `reading is stale` rather than quoting the number, which
 * is the one claim worse than saying nothing. A refusal is the provider's own
 * report of what it is doing with requests, and age does not make it less true.
 *
 * ## Nothing is hidden
 *
 * An exhausted model keeps its row, disabled, with the reason in words — the
 * desktop's `GatedItem` rule and the profile picker's. A model that vanishes
 * from the list at the moment somebody reaches for it is a model they conclude
 * was taken away, and the reason is usually a thing they could act on if
 * anybody told them what it was.
 */

import {
  PLAN_USAGE_MAX_AGE_MS,
  bindingWindow,
  isModelScoped,
  modelIdentity,
  planMeterSlots,
  type PlanUsage,
  type PlanUsageWindow,
} from '@rx-artemis/protocol';

import { resetClock } from './failover.js';

/**
 * As much of a catalogue entry as these facts need.
 *
 * A `ProviderModelOption` satisfies it, and so does the handful of fields a
 * caller has when it is holding a remembered selection rather than a live
 * listing. `resolvedModel` is optional and carried when it exists because it is
 * the second name a model answers to — `fable` resolving to `claude-fable-5` —
 * and the join below is better for having both.
 */
export interface ModelRef {
  readonly id: string;
  readonly label: string;
  /** The canonical wire id, when the catalogue publishes one. */
  readonly resolvedModel?: string;
}

/** The prefix a named per-model bucket carries, e.g. `model_scoped:Fable`. */
const MODEL_SCOPED_PREFIX = 'model_scoped:';

/**
 * Segments that appear in model ids and name no model.
 *
 * `claude` is the load-bearing one. Without it a bucket labelled
 * `7 days · Claude Fable` would match every Claude model in the list, which is
 * not a near miss but the whole feature inverted: every row disabled by one
 * model's limit.
 */
const GENERIC_SEGMENTS = new Set(['claude', 'anthropic', 'latest', 'preview']);

/**
 * The names this model could be mentioned under, most specific first.
 *
 * Ids are normalised through `modelIdentity` so the bracketed variant and the
 * dated snapshot — `claude-fable-5[1m]`, `claude-haiku-4-5-20251001` — are gone
 * before anything is compared; what is left is split on delimiters because no
 * bucket is ever called `claude-fable-5`, they are called `Fable`.
 *
 * Two filters keep the substring search below honest. A segment must be three
 * characters or more, which is what stops `us` matching inside `opus`, and it
 * must contain a letter, which drops the `5`s and `4.5`s that would otherwise
 * match any bucket whose name happens to carry a version number.
 */
function modelNames(model: ModelRef): readonly string[] {
  const names: string[] = [];
  const add = (value: string): void => {
    for (const segment of value.toLowerCase().split(/[^a-z0-9.]+/)) {
      if (segment.length < 3) continue;
      if (!/[a-z]/.test(segment)) continue;
      if (GENERIC_SEGMENTS.has(segment)) continue;
      if (!names.includes(segment)) names.push(segment);
    }
  };
  for (const key of modelIdentity({ note: '', ...model })) add(key);
  add(model.label);
  return names;
}

/**
 * The per-model bucket that meters *this* model, or `null`.
 *
 * `null` covers four honest states — no reading, a plan with no per-model
 * buckets, buckets that name other models, and a bucket too anonymous to
 * attach to anyone — and callers must not tell them apart: all four mean "this
 * model has no bucket of its own to answer for it". A verdict that cannot be
 * attached to a model must never disable one.
 *
 * Where several buckets name the model, the worst wins, for the reason
 * `focusedWindow` picks the worst within the family: averaging two limits
 * describes neither, and the one closest to full is the one that will stop you.
 * Unlike `handoff.ts`'s version this does not skip a bucket that reports no
 * percentage — the common live `plan.limit` event carries a verdict and a name
 * and no number at all, and that is precisely the reading a model must be able
 * to be out on.
 */
export function modelWindow(model: ModelRef, usage: PlanUsage | null | undefined): PlanUsageWindow | null {
  if (!usage?.available) return null;
  const names = modelNames(model);
  if (names.length === 0) return null;

  let best: PlanUsageWindow | null = null;
  for (const window of usage.windows) {
    if (!isModelScoped(window.id)) continue;
    const haystack = `${window.id} ${window.label}`.toLowerCase();
    if (!names.some((name) => haystack.includes(name))) continue;
    if (best === null) {
      best = window;
      continue;
    }
    if (best.status === 'rejected') continue;
    if (window.status === 'rejected' || (window.utilization ?? -1) > (best.utilization ?? -1)) {
      best = window;
    }
  }
  return best;
}

/**
 * The plan as this model experiences it: every shared window, plus its own
 * bucket, and no other model's.
 *
 * Narrowing the reading rather than reimplementing the ranking is the point —
 * `bindingWindow` then answers "what stops this model first" with the same
 * rejected-outranks-any-percentage rule it answers "what stops this account"
 * with.
 *
 * `seven_day_opus` and its kind stay in as shared windows, because that is what
 * the protocol's own family predicate says they are. A second opinion about
 * which ids are per-model, held only here, would be one more way for two
 * surfaces to describe one account differently.
 */
function windowsBinding(usage: PlanUsage, own: PlanUsageWindow | null): PlanUsage {
  return { ...usage, windows: usage.windows.filter((w) => w === own || !isModelScoped(w.id)) };
}

/**
 * How close this model is to being stopped.
 *
 * `out` is both ends of the same state on purpose — a window the provider is
 * refusing on and a window at 92% are the same thing to the person about to
 * pick the row. `none` is "nothing is metered, or nothing recent enough to
 * quote", never "plenty of room": the absence of a reading is not a reading.
 */
export type ModelPressure = 'none' | 'low' | 'high' | 'out';

/** The facts a row is drawn from. @see modelRowFacts for the row itself. */
export interface ModelFacts {
  /** The provider is refusing this model on this account, right now. */
  readonly exhausted: boolean;
  /** When the window this row is about rolls over, if it says. */
  readonly resetsAt?: number;
  readonly pressure: ModelPressure;
  /** `fable 92% · resets 14:30`, `week 40%`, `reading is stale`, or nothing. */
  readonly pressureLabel: string;
  /** The window that would stop this model first, as the meters name it. */
  readonly bindingLabel: string;
}

/** Everything both public functions need, computed once. */
interface Reading {
  readonly own: PlanUsageWindow | null;
  readonly binding: PlanUsageWindow | null;
  /** The window doing the refusing, when one is. */
  readonly refusing: PlanUsageWindow | null;
  readonly pressure: ModelPressure;
  /** The binding window's reading, rounded. `null` when it reports none. */
  readonly percent: number | null;
  readonly label: string;
  readonly bindingLabel: string;
}

/**
 * The short name for a window: the meter's where the meter draws one, the
 * bucket's own name where it does not.
 *
 * Lowercased, because these are our words rather than the provider's and this
 * is a dim trailing detail — `fable 92%` next to `5hr 12%` rather than a row
 * of proper nouns. A window the meter has no name for keeps the provider's
 * label exactly as the provider cased it; re-casing somebody else's copy is
 * how a label stops being quotable.
 *
 * A bucket's own name is asked for before the meter's, and only because
 * `planMeterSlots` falls back to the provider's label for a plan with none of
 * the three named windows on it. `model_scoped:Opus` is `opus` here either
 * way — this just keeps it from being `7 days · opus` on the one plan that has
 * nothing else to meter.
 */
function shortName(usage: PlanUsage, window: PlanUsageWindow, now: number): string {
  const named = window.id.startsWith(MODEL_SCOPED_PREFIX)
    ? window.id.slice(MODEL_SCOPED_PREFIX.length).trim()
    : '';
  if (named.length > 0) return named.toLowerCase();
  const slot = planMeterSlots(usage, now).find((s) => s.window.id === window.id);
  // A slot standing under the provider's own label is the meter's fallback for
  // a plan with none of the three named windows on it, not a short name of
  // ours to lowercase. Without this the same window would be `Extra usage` on
  // one plan and `extra usage` on another, which is one window with two names.
  if (slot === undefined || slot.label === window.label) return window.label;
  return slot.label.toLowerCase();
}

/**
 * A reset as a clock, with the weekday when it is not today.
 *
 * `failover.ts`'s `resetClock` does the formatting — one 24-hour clock in the
 * terminal, not two — and this adds the only thing a weekly window needs that a
 * 5-hour one does not: `14:30` four days out would read as this afternoon.
 */
function resetLabel(resetsAt: number, now: number): string {
  const at = new Date(resetsAt);
  if (at.toDateString() === new Date(now).toDateString()) return resetClock(resetsAt);
  return `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${resetClock(resetsAt)}`;
}

/**
 * A reset worth naming, or `null`.
 *
 * A reset time already in the past describes nothing anybody can wait for — the
 * window has rolled and this reading has not caught up — so it is dropped
 * rather than printed as an hour that has been and gone. The raw instant is
 * still carried on {@link ModelFacts.resetsAt} for callers that want to reason
 * about it rather than print it.
 */
function upcomingReset(window: PlanUsageWindow | null, now: number): string | null {
  const resetsAt = window?.resetsAt ?? null;
  if (resetsAt === null || resetsAt - now <= 0) return null;
  return resetLabel(resetsAt, now);
}

function read(model: ModelRef, usage: PlanUsage | null | undefined, now: number): Reading {
  const empty: Reading = {
    own: null,
    binding: null,
    refusing: null,
    pressure: 'none',
    percent: null,
    label: '',
    bindingLabel: '',
  };
  if (!usage?.available) return empty;

  const own = modelWindow(model, usage);
  const binding = bindingWindow(windowsBinding(usage, own), now);
  if (binding === null) return empty;

  // The model's own bucket answers for the model; the account's binding window
  // answers only for a model that has no bucket of its own. See the header.
  const refusing =
    own !== null
      ? own.status === 'rejected'
        ? own
        : null
      : binding.status === 'rejected'
        ? binding
        : null;

  const bindingLabel = shortName(usage, binding, now);
  const percent = binding.utilization === null ? null : Math.round(binding.utilization);

  // A forecast from a reading three polls old is not a forecast, and a number
  // quoted from one is worse than no number. The verdict above is untouched.
  if (Math.max(0, now - usage.fetchedAt) > PLAN_USAGE_MAX_AGE_MS) {
    return { own, binding, refusing, pressure: 'none', percent, label: 'reading is stale', bindingLabel };
  }

  // Banded on the reading rather than on the rounded figure, because that is
  // where `toneFor` and `handoffTrigger` band: a window at 89.6% is amber on
  // the meter under the composer, and a picker calling the same window red
  // would be the second opinion this file exists not to hold. The rounded
  // number is for printing and nothing else.
  const level = binding.utilization;
  const pressure: ModelPressure =
    binding.status === 'rejected'
      ? 'out'
      : level === null
        ? 'none'
        : level >= 90
          ? 'out'
          : level >= 75
            ? 'high'
            : 'low';

  const head =
    binding.status === 'rejected'
      ? `${bindingLabel} out`
      : percent === null
        ? ''
        : `${bindingLabel} ${String(percent)}%`;
  // The reset joins the label only where somebody is deciding whether to wait,
  // which is at the point of being stopped. At 40% it is noise in a line that
  // has to share a row with a model name.
  const reset = pressure === 'out' ? upcomingReset(binding, now) : null;
  const label = head === '' ? '' : reset === null ? head : `${head} · resets ${reset}`;

  return { own, binding, refusing, pressure, percent, label, bindingLabel };
}

/**
 * The three facts about this model on this account.
 *
 * Every field is safe to render blind: the strings are empty rather than
 * `undefined` when there is nothing to say, so a caller never has to decide
 * what "no reading" looks like — which is how one surface ends up printing
 * `0%` for an account nobody has polled.
 */
export function modelFacts(model: ModelRef, usage: PlanUsage | null | undefined, now = Date.now()): ModelFacts {
  const reading = read(model, usage, now);
  const subject = reading.refusing ?? reading.binding;
  const resetsAt = subject?.resetsAt ?? null;
  return {
    exhausted: reading.refusing !== null,
    ...(resetsAt === null ? {} : { resetsAt }),
    pressure: reading.pressure,
    pressureLabel: reading.label,
    bindingLabel: reading.bindingLabel,
  };
}

/** A `/model` row's plan-aware parts, ready to spread onto a `PickerItem`. */
export interface ModelRowFacts {
  /** Dimmed after the label. Empty when nothing about this model is metered. */
  readonly detail: string;
  readonly disabled: boolean;
  /** Why it cannot be picked. Replaces `detail` on the row. */
  readonly reason?: string;
  /** A second, dimmer line — only where the number needs a sentence. */
  readonly note?: string;
}

/**
 * The same facts as a row.
 *
 * Three states, and the wording of each is the decision:
 *
 *  - **Refused.** Disabled with the reason in words, the reset included when
 *    the provider gives one, because "until 14:30" is the difference between
 *    waiting and switching accounts. "on this account" rather than "on this
 *    plan" — the account is the thing the user can change with one keystroke.
 *  - **Under pressure at 75–90%.** The number in the detail, and a note in
 *    prose naming the window, because a bare `5hr 81%` on a row nobody was
 *    reading carefully is a fact without a consequence. The note reuses the
 *    detail's vocabulary for the window rather than a longer synonym, so the
 *    two lines cannot be read as being about two different limits.
 *  - **Anything else.** The reading, or nothing at all. A row with no note is
 *    the overwhelmingly common case and it should stay that way: a picker where
 *    every row carries a second line is a picker nobody reads the second lines
 *    of.
 */
export function modelRowFacts(model: ModelRef, usage: PlanUsage | null | undefined, now = Date.now()): ModelRowFacts {
  const reading = read(model, usage, now);
  if (reading.refusing !== null) {
    const until = upcomingReset(reading.refusing, now);
    return {
      detail: '',
      disabled: true,
      reason: until === null ? 'out on this account' : `out on this account until ${until}`,
    };
  }
  const note =
    reading.pressure === 'high' && reading.percent !== null
      ? `high pressure — the ${reading.bindingLabel} window is at ${String(reading.percent)}%`
      : null;
  return { detail: reading.label, disabled: false, ...(note === null ? {} : { note }) };
}
