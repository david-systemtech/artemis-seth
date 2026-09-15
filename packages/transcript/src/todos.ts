/**
 * The agent's own checklist, read back out of its tool calls.
 * ============================================================================
 *
 * Every provider with any planning ability writes a to-do list mid-turn, and
 * each one spells it differently: Claude's `TodoWrite` takes `{ todos: [{
 * content, status, activeForm }] }`, Codex's `update_plan` takes `{
 * explanation?, plan: [{ step, status }] }`, Gemini's `write_todos` takes `{
 * todos: [{ description, status }] }`. Artemis has counted those calls since
 * the day it shipped — "updated the plan 3 times", from {@link classifyTool},
 * which already files every one of them under `plan` — without once showing
 * *what the plan was*. The checklist is the closest thing an agent produces to
 * a statement of intent, and it was the one thing on screen nowhere.
 *
 * This module is the reading half of that: names and shapes in, one normalised
 * list out. It lives here rather than in the terminal UI because the desktop
 * wants the identical answer — `AcpSessionUpdate` even declares a `plan`
 * variant the mapper drops today for want of a surface — and because a parser
 * of other people's JSON is exactly the kind of thing worth testing without
 * mounting a component.
 *
 * ## Tolerant on purpose, and where the tolerance stops
 *
 * Three known shapes would be three `if`s; what is here instead is one shape
 * test applied to a handful of key names, because the next provider will spell
 * it a fourth way and the failure mode of a closed list is a blank strip with
 * no clue why. So: a name that says todo or plan, a list under one of the keys
 * lists live under, entries that carry *some* text and *some* status.
 *
 * The tolerance stops at the status. At least one entry must carry a status a
 * reader would recognise, which is what keeps this from claiming that an
 * unrelated tool's `items` array is a checklist — a to-do list without any
 * notion of done is not a to-do list, it is an array. Entries that do not parse
 * are dropped rather than failing the list, since half a checklist is still
 * worth drawing; a list where nothing parses is `null`, which the caller reads
 * as "there is nothing to show" and not as "show an empty list".
 *
 * `exitplanmode` is the one name excluded by hand. It matches "plan", it is
 * classified `plan`, and its `plan` field is a markdown document rather than a
 * list of steps — the shape test would reject it anyway, and saying so here is
 * cheaper than making the next reader work that out.
 */

import type { JsonObject, JsonValue } from '@rx-artemis/protocol';

import type { TranscriptModel } from './transcript.js';

/**
 * Where one item has got to.
 *
 * Four states, which is the union of what the three providers emit: Claude and
 * Codex know three and Gemini adds `cancelled` for a step the agent decided
 * against. A fourth state costs one glyph and records a real event — work
 * dropped on purpose is not work left undone.
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

/** One line of the agent's checklist, in our words rather than a provider's. */
export interface TodoItem {
  readonly text: string;
  readonly status: TodoStatus;
}

/** The checklist as it last stood, and when the agent said so. */
export interface TodoSnapshot {
  readonly items: readonly TodoItem[];
  /** The timestamp of the call that wrote it. */
  readonly ts: number;
}

/**
 * Keys an entry's words might be under, in order of preference.
 *
 * `content` is Claude's and ACP's, `step` is Codex's, `description` is
 * Gemini's; the rest are guesses at a provider we have not met. Claude's
 * `activeForm` ("Running the tests") is deliberately not among them: it is the
 * same item in the gerund, and preferring it would put one row of a list in a
 * different grammatical mood from its neighbours.
 */
const TEXT_KEYS: readonly string[] = [
  'content',
  'step',
  'description',
  'text',
  'task',
  'title',
  'label',
  'name',
];

/** Keys the list itself might be under. `todos`, `plan` and `items` are real. */
const LIST_KEYS: readonly string[] = ['todos', 'plan', 'items', 'steps', 'entries', 'tasks'];

/**
 * Status spellings, normalised, to the four states.
 *
 * More entries than any provider uses, for the reason the key lists are long:
 * an unrecognised status reads as `pending`, and a checklist that shows
 * finished work as outstanding is worse than useless.
 */
const STATUSES: Readonly<Record<string, TodoStatus>> = {
  pending: 'pending',
  todo: 'pending',
  notstarted: 'pending',
  queued: 'pending',
  open: 'pending',
  inprogress: 'in_progress',
  active: 'in_progress',
  running: 'in_progress',
  current: 'in_progress',
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
  finished: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  skipped: 'cancelled',
  abandoned: 'cancelled',
};

/** Case and separators are the only difference between `write_todos` and `writeTodos`. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[_\-\s.]/g, '');
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/**
 * Is this the name of a tool that writes a checklist?
 *
 * A substring test rather than a table, so `TodoWrite`, `write_todos`,
 * `update_plan` and `mcp__something__todo_write` all pass without an entry
 * each. It is only half the test — the shape has to agree — which is what
 * makes a loose name rule safe.
 */
export function isTodoTool(name: string): boolean {
  const key = normalize(name);
  // Matches "plan", is classified `plan`, and is not one: its `plan` is a
  // markdown proposal, and its job is to ask to stop planning.
  if (key === 'exitplanmode') return false;
  return key.includes('todo') || key.includes('plan');
}

/**
 * A tool call's input, read as a checklist.
 *
 * `null` when the tool is not a todo tool, or when the input does not parse as
 * a list of items — both of which the caller treats the same way, because
 * either way there is nothing to draw.
 */
export function parseTodos(
  toolName: string,
  input: JsonValue | undefined,
): readonly TodoItem[] | null {
  if (!isTodoTool(toolName)) return null;

  const list = listIn(input);
  if (list === null) return null;

  const items: TodoItem[] = [];
  let recognised = 0;
  for (const entry of list) {
    if (!isJsonObject(entry)) continue;
    const text = textIn(entry);
    if (text === null) continue;
    const status = statusIn(entry);
    if (status !== null) recognised += 1;
    items.push({ text, status: status ?? 'pending' });
  }

  // Nothing readable, or nothing that admits to being done or not: an array,
  // rather than a checklist. See the file header.
  if (items.length === 0 || recognised === 0) return null;
  return items;
}

/** The array the items are in: the input itself, or the first list-shaped key. */
function listIn(input: JsonValue | undefined): readonly JsonValue[] | null {
  if (isJsonArray(input)) return input;
  if (!isJsonObject(input)) return null;
  for (const key of LIST_KEYS) {
    const value = input[key];
    if (isJsonArray(value)) return value;
  }
  return null;
}

/** The first key that holds words. Whitespace-only counts as no words. */
function textIn(entry: JsonObject): string | null {
  for (const key of TEXT_KEYS) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** The entry's state, or `null` when it does not carry one we know. */
function statusIn(entry: JsonObject): TodoStatus | null {
  const raw = entry['status'] ?? entry['state'];
  if (typeof raw !== 'string') return null;
  return STATUSES[normalize(raw)] ?? null;
}

/**
 * The checklist the agent most recently wrote, anywhere in the transcript.
 *
 * By `ts` and *regardless of the call's status*, which is the whole point: the
 * list is the call's **input**, so it is true the instant the call is made and
 * does not wait on a result. A strip that showed it only once `tool.end`
 * landed would blank itself for exactly as long as the provider took to
 * acknowledge the write — the moment the plan changed being the moment it most
 * wanted reading.
 *
 * A full scan of the item list per call, which is the same O(items) the model's
 * own `rebuildRows` pays on a structural change: {@link parseTodos} bails on
 * the name for anything that is not a todo tool, so the scan is a map lookup
 * and a string test per item. Ties on `ts` go to the later position, since two
 * writes in the same millisecond are still in the order they arrived.
 */
export function latestTodos(model: TranscriptModel): TodoSnapshot | null {
  let latest: TodoSnapshot | null = null;
  // The item list, not the *row* list: a todo call is ordinary machinery and is
  // usually folded away inside an activity group, where the rows cannot see it.
  for (const id of model.getListSnapshot()) {
    const item = model.getItem(id);
    if (item === undefined || item.kind !== 'tool') continue;
    if (latest !== null && item.ts < latest.ts) continue;
    const items = parseTodos(item.name, item.input);
    if (items === null) continue;
    latest = { items, ts: item.ts };
  }
  return latest;
}
