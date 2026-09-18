/*
 * What a model row is allowed to claim about the account it is offered on.
 *
 * Three things are worth pinning here, and all three fail silently rather than
 * loudly. That a bucket is joined to the model it is actually about: the join
 * is on names, so the way it breaks is a bucket handed to the wrong model —
 * one row struck out for a limit it does not share, or every row struck out by
 * the word `claude` appearing in every id. That a refusal disables a row and a
 * percentage never does, because the only thing worse than a picker that hides
 * an unusable model is one that hides a usable one. And that every string is
 * the string some other surface already prints — `5hr`, `week`, `fable`,
 * `14:30` — since a picker that invents its own vocabulary for the meter two
 * lines below it teaches people there are more limits than there are.
 */

import { describe, expect, it } from 'vitest';

import { PLAN_USAGE_MAX_AGE_MS, type PlanUsage, type PlanUsageWindow } from '@rx-artemis/protocol';

import { modelFacts, modelRowFacts, modelWindow, type ModelRef } from './modelFacts.js';

/*
 * Noon on a Thursday, with the reset half past two the same afternoon, both
 * built in local time so the clock these render to is `14:30` wherever the
 * suite runs.
 */
const NOW = new Date(2026, 8, 10, 12, 0).getTime();
const HALF_TWO = new Date(2026, 8, 10, 14, 30).getTime();
const MONDAY = new Date(2026, 8, 14, 14, 30).getTime();

const window = (patch: Partial<PlanUsageWindow> & Pick<PlanUsageWindow, 'id'>): PlanUsageWindow => ({
  label: patch.id,
  utilization: null,
  resetsAt: null,
  ...patch,
});

const usage = (windows: readonly PlanUsageWindow[], fetchedAt = NOW): PlanUsage => ({
  available: true,
  windows,
  fetchedAt,
});

const fiveHour = (utilization: number | null, patch: Partial<PlanUsageWindow> = {}): PlanUsageWindow =>
  window({ id: 'five_hour', label: '5 hours', utilization, ...patch });

const week = (utilization: number | null, patch: Partial<PlanUsageWindow> = {}): PlanUsageWindow =>
  window({ id: 'seven_day', label: '7 days', utilization, ...patch });

/** A per-model bucket spelled the way the common account spells it. */
const bucket = (name: string, utilization: number | null, patch: Partial<PlanUsageWindow> = {}): PlanUsageWindow =>
  window({ id: `model_scoped:${name}`, label: `7 days · ${name}`, utilization, ...patch });

/*
 * Two catalogue entries, deliberately spelled differently: Fable as the live
 * listing publishes it (a bracketed variant id), Sonnet as the built-in list
 * does (a bare alias with the wire id alongside). The join has to survive both.
 */
const FABLE: ModelRef = { id: 'claude-fable-5[1m]', label: 'Fable', resolvedModel: 'claude-fable-5' };
const SONNET: ModelRef = { id: 'sonnet', label: 'Sonnet 4.5', resolvedModel: 'claude-sonnet-4-5' };

const NO_PLAN: PlanUsage = { available: false, windows: [], fetchedAt: NOW, unavailableReason: 'API key billing' };

describe('modelWindow', () => {
  it('joins a bucket that names the model in its id', () => {
    const fable = bucket('Fable', 40);
    expect(modelWindow(FABLE, usage([fiveHour(12), week(20), fable]))).toBe(fable);
  });

  it('joins a bucket that names the model only in its label', () => {
    // The other spelling in the wild: an anonymous `model_scoped` id with the
    // model's name carried in the display label. `handoff.ts` matches on the
    // two joined, and so does this, or the rule would fire on one account and
    // silently never on the next.
    const anonymous = window({ id: 'model_scoped', label: '7 days · Fable', utilization: 40 });
    expect(modelWindow(FABLE, usage([anonymous]))).toBe(anonymous);
    expect(modelWindow(SONNET, usage([anonymous]))).toBeNull();
  });

  it('does not hand one model’s bucket to another', () => {
    expect(modelWindow(SONNET, usage([bucket('Fable', 90)]))).toBeNull();
    expect(modelWindow(FABLE, usage([bucket('Opus', 90)]))).toBeNull();
  });

  it('does not let the `claude` every id carries match every bucket', () => {
    // The failure this guards is not a near miss, it is the feature inverted:
    // one model's limit disabling the whole list.
    const claudeish = window({ id: 'model_scoped', label: '7 days · Claude Fable', utilization: 99 });
    expect(modelWindow(SONNET, usage([claudeish]))).toBeNull();
    expect(modelWindow(FABLE, usage([claudeish]))).toBe(claudeish);
  });

  it('takes the worst bucket where more than one names the model', () => {
    // Averaging two limits describes neither, and the one closest to full is
    // the one that will stop you.
    const light = bucket('Fable', 40);
    const heavy = window({ id: 'model_scoped', label: 'Fable, extra', utilization: 88 });
    expect(modelWindow(FABLE, usage([light, heavy]))).toBe(heavy);
  });

  it('lets a refusal outrank any percentage among them', () => {
    const refused = window({ id: 'model_scoped', label: 'Fable, extra', status: 'rejected' });
    expect(modelWindow(FABLE, usage([bucket('Fable', 99), refused]))).toBe(refused);
  });

  it('keeps a bucket the provider reported no number for', () => {
    // The commonest live `plan.limit` event carries a verdict and a name and
    // no percentage at all, and that is precisely the reading a model has to
    // be able to be out on. `handoff.ts` skips these; a verdict cannot.
    const bare = bucket('Fable', null, { status: 'rejected' });
    expect(modelWindow(FABLE, usage([bare]))).toBe(bare);
  });

  it('answers nothing with no reading, no plan limits, or no per-model buckets', () => {
    expect(modelWindow(FABLE, null)).toBeNull();
    expect(modelWindow(FABLE, NO_PLAN)).toBeNull();
    expect(modelWindow(FABLE, usage([fiveHour(40), week(10)]))).toBeNull();
  });
});

describe('modelFacts — exhaustion', () => {
  it('is out when the model’s own bucket is being refused', () => {
    const plan = usage([fiveHour(12), week(40), bucket('Fable', 100, { status: 'rejected', resetsAt: HALF_TWO })]);
    expect(modelFacts(FABLE, plan, NOW)).toEqual({
      exhausted: true,
      resetsAt: HALF_TWO,
      pressure: 'out',
      pressureLabel: 'fable out · resets 14:30',
      bindingLabel: 'fable',
    });
  });

  it('leaves every other model on that account choosable', () => {
    const plan = usage([fiveHour(12), week(40), bucket('Fable', 100, { status: 'rejected' })]);
    const sonnet = modelFacts(SONNET, plan, NOW);
    expect(sonnet.exhausted).toBe(false);
    // Fable's bucket is not Sonnet's constraint and does not tint its row.
    expect(sonnet.pressure).toBe('low');
    expect(sonnet.pressureLabel).toBe('week 40%');
  });

  it('answers off the account’s binding window for a model with no bucket of its own', () => {
    const plan = usage([fiveHour(97, { status: 'rejected', resetsAt: HALF_TWO }), week(40)]);
    const facts = modelFacts(SONNET, plan, NOW);
    expect(facts.exhausted).toBe(true);
    expect(facts.bindingLabel).toBe('5hr');
    expect(facts.resetsAt).toBe(HALF_TWO);
  });

  it('does not disable a model whose own bucket has room while the account is out', () => {
    // The asymmetry the whole module turns on: the account being out is the
    // failover line's sentence to say, and a row is disabled only when the
    // thing being refused is the row itself. Pressure still reports it.
    const plan = usage([fiveHour(100, { status: 'rejected', resetsAt: HALF_TWO }), bucket('Fable', 10)]);
    const facts = modelFacts(FABLE, plan, NOW);
    expect(facts.exhausted).toBe(false);
    expect(facts.pressure).toBe('out');
    expect(facts.bindingLabel).toBe('5hr');
  });

  it('fires on the verdict and never on a percentage', () => {
    expect(modelFacts(FABLE, usage([bucket('Fable', 100)]), NOW).exhausted).toBe(false);
    expect(modelFacts(FABLE, usage([bucket('Fable', 3, { status: 'rejected' })]), NOW).exhausted).toBe(true);
  });
});

describe('modelFacts — pressure', () => {
  const at = (utilization: number): string => modelFacts(SONNET, usage([fiveHour(utilization)]), NOW).pressure;

  it('bands at the thresholds the meter draws its colours at', () => {
    // `PlanUsageMeter.toneFor`: amber at 75, red at 90, and read off the
    // reading rather than the rounded figure, so 89.6% is never amber on the
    // meter and red in the picker.
    expect(at(0)).toBe('low');
    expect(at(40)).toBe('low');
    expect(at(74.9)).toBe('low');
    expect(at(75)).toBe('high');
    expect(at(81)).toBe('high');
    expect(at(89.9)).toBe('high');
    expect(at(90)).toBe('out');
    expect(at(92)).toBe('out');
  });

  it('is out on a refusal whatever the percentage reads', () => {
    expect(modelFacts(SONNET, usage([fiveHour(12, { status: 'rejected' })]), NOW).pressure).toBe('out');
  });

  it('is none when nothing is metered, which is not the same as plenty of room', () => {
    expect(modelFacts(SONNET, usage([fiveHour(null)]), NOW)).toEqual({
      exhausted: false,
      pressure: 'none',
      pressureLabel: '',
      bindingLabel: '',
    });
  });

  it('names the window and the number the way the meter does', () => {
    expect(modelFacts(SONNET, usage([fiveHour(12), week(40)]), NOW).pressureLabel).toBe('week 40%');
    const plan = usage([fiveHour(12), week(40), bucket('Fable', 92, { resetsAt: HALF_TWO })]);
    expect(modelFacts(FABLE, plan, NOW).pressureLabel).toBe('fable 92% · resets 14:30');
  });

  it('adds the reset only where somebody is deciding whether to wait', () => {
    // At 40% it is noise in a line that has to share a row with a model name.
    expect(modelFacts(SONNET, usage([fiveHour(40, { resetsAt: HALF_TWO })]), NOW).pressureLabel).toBe('5hr 40%');
    expect(modelFacts(SONNET, usage([fiveHour(95, { resetsAt: HALF_TWO })]), NOW).pressureLabel).toBe(
      '5hr 95% · resets 14:30',
    );
  });

  it('carries the weekday on a reset that is not today', () => {
    // `14:30` four days out would read as this afternoon.
    expect(modelFacts(SONNET, usage([fiveHour(95, { resetsAt: MONDAY })]), NOW).pressureLabel).toMatch(
      /^5hr 95% · resets \S+ 14:30$/,
    );
  });

  it('drops a reset that has already been and gone, and still carries the instant', () => {
    const past = usage([fiveHour(95, { resetsAt: NOW - 60_000 })]);
    expect(modelFacts(SONNET, past, NOW).pressureLabel).toBe('5hr 95%');
    expect(modelFacts(SONNET, past, NOW).resetsAt).toBe(NOW - 60_000);
  });

  it('calls one window by one name whatever else the plan meters', () => {
    // A window the meter has no short name for keeps the provider's own label,
    // on the plan where it stands alone as much as on the plan where it does
    // not — one window with two spellings is two windows to a reader.
    const extra = window({ id: 'extra_usage', label: 'Extra usage', utilization: 60 });
    expect(modelFacts(SONNET, usage([fiveHour(10), week(20), extra]), NOW).pressureLabel).toBe('Extra usage 60%');
    expect(modelFacts(SONNET, usage([extra]), NOW).pressureLabel).toBe('Extra usage 60%');
  });
});

describe('modelFacts — freshness', () => {
  it('will not quote a number nobody has refreshed', () => {
    const stale = usage([fiveHour(92)], NOW - PLAN_USAGE_MAX_AGE_MS - 1);
    const facts = modelFacts(SONNET, stale, NOW);
    expect(facts.pressure).toBe('none');
    expect(facts.pressureLabel).toBe('reading is stale');
    // The window is still named — what expired is the forecast, not the subject.
    expect(facts.bindingLabel).toBe('5hr');
  });

  it('quotes it again one millisecond the fresh side of the bar', () => {
    const fresh = usage([fiveHour(92)], NOW - PLAN_USAGE_MAX_AGE_MS);
    expect(modelFacts(SONNET, fresh, NOW).pressure).toBe('out');
  });

  it('trusts a refusal however old the reading is', () => {
    // A percentage goes stale; "I am refusing your requests" does not.
    const stale = usage([bucket('Fable', null, { status: 'rejected', resetsAt: HALF_TWO })], NOW - PLAN_USAGE_MAX_AGE_MS - 1);
    const facts = modelFacts(FABLE, stale, NOW);
    expect(facts.exhausted).toBe(true);
    expect(facts.pressure).toBe('none');
    expect(facts.pressureLabel).toBe('reading is stale');
  });
});

describe('modelFacts — nothing to report', () => {
  it('says nothing about an account nobody has read', () => {
    const nothing = { exhausted: false, pressure: 'none', pressureLabel: '', bindingLabel: '' };
    expect(modelFacts(FABLE, null, NOW)).toEqual(nothing);
    expect(modelFacts(FABLE, undefined, NOW)).toEqual(nothing);
    expect(modelFacts(FABLE, NO_PLAN, NOW)).toEqual(nothing);
  });
});

describe('modelRowFacts', () => {
  it('disables a refused model and says when it comes back', () => {
    const plan = usage([fiveHour(12), bucket('Fable', 100, { status: 'rejected', resetsAt: HALF_TWO })]);
    expect(modelRowFacts(FABLE, plan, NOW)).toEqual({
      detail: '',
      disabled: true,
      // "on this account" rather than "on this plan": the account is the thing
      // the user can change with one keystroke.
      reason: 'out on this account until 14:30',
    });
  });

  it('still disables it when the provider will not say when', () => {
    const plan = usage([bucket('Fable', null, { status: 'rejected' })]);
    expect(modelRowFacts(FABLE, plan, NOW)).toEqual({ detail: '', disabled: true, reason: 'out on this account' });
  });

  it('keeps the row rather than hiding it', () => {
    // The desktop's `GatedItem` rule: a model that vanishes at the moment
    // somebody reaches for it is a model they conclude was taken away.
    const plan = usage([bucket('Fable', 100, { status: 'rejected' })]);
    expect(modelRowFacts(FABLE, plan, NOW).reason).not.toBe('');
  });

  it('puts a sentence under a row at high pressure', () => {
    const plan = usage([fiveHour(81), week(40)]);
    expect(modelRowFacts(SONNET, plan, NOW)).toEqual({
      detail: '5hr 81%',
      disabled: false,
      // The note reuses the detail's word for the window, so the two lines
      // cannot be read as being about two different limits.
      note: 'high pressure — the 5hr window is at 81%',
    });
  });

  it('leaves the common row a number and nothing else', () => {
    // A picker where every row carries a second line is a picker nobody reads
    // the second lines of.
    expect(modelRowFacts(SONNET, usage([fiveHour(12), week(40)]), NOW)).toEqual({
      detail: 'week 40%',
      disabled: false,
    });
    expect(modelRowFacts(SONNET, usage([fiveHour(95)]), NOW)).toEqual({ detail: '5hr 95%', disabled: false });
  });

  it('says nothing at all when nothing about this model is metered', () => {
    expect(modelRowFacts(SONNET, null, NOW)).toEqual({ detail: '', disabled: false });
    expect(modelRowFacts(SONNET, NO_PLAN, NOW)).toEqual({ detail: '', disabled: false });
    expect(modelRowFacts(SONNET, usage([fiveHour(null)]), NOW)).toEqual({ detail: '', disabled: false });
  });

  it('shows a stale reading as stale rather than as a number', () => {
    const stale = usage([fiveHour(81)], NOW - PLAN_USAGE_MAX_AGE_MS - 1);
    expect(modelRowFacts(SONNET, stale, NOW)).toEqual({ detail: 'reading is stale', disabled: false });
  });

  it('disables a model on a stale refusal all the same', () => {
    const stale = usage([fiveHour(100, { status: 'rejected', resetsAt: HALF_TWO })], NOW - PLAN_USAGE_MAX_AGE_MS - 1);
    expect(modelRowFacts(SONNET, stale, NOW)).toEqual({
      detail: '',
      disabled: true,
      reason: 'out on this account until 14:30',
    });
  });

  it('does not strike out the whole list because the account is out', () => {
    // The row that has a bucket of its own with room in it stays choosable and
    // carries the account's own trouble as a detail; the row that has none is
    // the one the refusal is actually about.
    const plan = usage([fiveHour(100, { status: 'rejected', resetsAt: HALF_TWO }), bucket('Fable', 10)]);
    expect(modelRowFacts(FABLE, plan, NOW)).toEqual({ detail: '5hr out · resets 14:30', disabled: false });
    expect(modelRowFacts(SONNET, plan, NOW).disabled).toBe(true);
  });
});
