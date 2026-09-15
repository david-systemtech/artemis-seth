/**
 * `artemis ls` — the stored conversations, from outside the screen.
 *
 * The rail answers "what have I been working on" for somebody already looking
 * at Artemis. This answers it for a shell script, an `fzf` binding, or a person
 * who wants nothing but the id to hand to `--resume`: no boxes, no terminal
 * required, one conversation per line.
 *
 * The rows are the rail's rows. `refreshRail` reads every account that is not
 * hidden through `listSessionsAcross`, and so does this, so a conversation that
 * is on the rail is on this list and neither surface makes anyone remember
 * which account they were on. What is narrowed here is the *directory*: this
 * one, the way `ls` is about the directory you are standing in, unless `--all`
 * asks for everywhere the account has worked.
 *
 * **Ids are printed whole.** `--resume` passes what it is given to the provider
 * verbatim and resolves no prefixes, so an abbreviated id would be a value that
 * looks pasteable and is not. The column is wide because what goes in it has to
 * work.
 *
 * Two shapes. The table is padded for eyes; `--json` is JSON Lines — one object
 * per conversation, newline-terminated, every key present so an absent branch
 * is `null` rather than a key that moved and a `jq` filter never has to ask
 * whether a field exists. Everything above the final twenty lines is pure
 * formatting, which is the part with tests.
 */

import type { SessionSummary } from '@rx-artemis/protocol';
import { formatRelative, oneLine } from '@rx-artemis/transcript';

import type { Launched } from './launch.js';

export interface SessionsIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface ListOptions {
  /** Every directory the accounts have worked in, not only the one `ls` ran in. */
  readonly all: boolean;
  /** JSON Lines instead of the table. */
  readonly json: boolean;
}

/**
 * One line of `--json`.
 *
 * A deliberate subset of {@link SessionSummary}: what a script picks a
 * conversation by. The rest of the summary — which account's store it was found
 * in, how the title was arrived at, the tag — is Artemis's own bookkeeping, and
 * putting it on the wire would make it a promise.
 */
export interface SessionJson {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly cwd: string;
  readonly gitBranch: string | null;
  readonly model: string | null;
  readonly messageCount: number | null;
}

/** What goes in a column that has nothing to show. */
const NOTHING = '—';

/** Longest title the table prints, past which it is clipped with an ellipsis. */
const TITLE_CHARS = 72;

/**
 * Paths compared as strings, with a trailing separator ignored.
 *
 * `cwd` on a summary is read out of the transcript rather than decoded from a
 * directory name (see `SessionSummary`), and the one `ls` runs in has been
 * through `resolve()`, so both are already absolute and normalised. A trailing
 * slash is the one difference a person can still introduce, by typing
 * `--cwd ./thing/`.
 */
function samePath(a: string, b: string): boolean {
  const trim = (path: string): string => (path.length > 1 ? path.replace(/[/\\]+$/, '') : path);
  return trim(a) === trim(b);
}

/**
 * The conversations this listing is about, newest first.
 *
 * Sorted here rather than trusted from the host: the list is assembled from
 * several accounts' stores, and a caller that filtered it should not have to
 * know whether the merge preserved an order.
 */
export function selectSessions(sessions: readonly SessionSummary[], cwd: string, all: boolean): readonly SessionSummary[] {
  const kept = all ? [...sessions] : sessions.filter((session) => samePath(session.cwd, cwd));
  return kept.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** One conversation, as `--json` writes it. */
export function sessionJson(session: SessionSummary): SessionJson {
  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    cwd: session.cwd,
    gitBranch: session.gitBranch ?? null,
    model: session.model ?? null,
    messageCount: session.messageCount ?? null,
  };
}

/** JSON Lines: one object per line, each line complete in itself, so it pipes. */
export function sessionsJsonl(sessions: readonly SessionSummary[]): string {
  return sessions.map((session) => `${JSON.stringify(sessionJson(session))}\n`).join('');
}

/**
 * `id  updated  branch  title`, in columns.
 *
 * No header row. Every line is a conversation, which is what makes
 * `artemis ls | head -1 | cut -d' ' -f1` the id of the newest one instead of
 * the word "id"; the columns are unmistakable without being named, and `--json`
 * is there for anything that wants field names.
 *
 * The first three columns are padded to their widest cell so the eye can run
 * down them, and the title comes last, unpadded and clipped to one line —
 * a conversation is titled with its opening prompt until the provider writes a
 * summary, and an unclipped prompt is a paragraph.
 */
export function sessionsTable(sessions: readonly SessionSummary[], now = Date.now()): string {
  const rows = sessions.map((session) => ({
    id: session.id,
    updated: formatRelative(session.updatedAt, now) || NOTHING,
    branch: session.gitBranch ?? NOTHING,
    title: oneLine(session.title, TITLE_CHARS) || NOTHING,
  }));
  const widest = (pick: (row: (typeof rows)[number]) => string): number =>
    rows.reduce((width, row) => Math.max(width, pick(row).length), 0);
  const ids = widest((row) => row.id);
  const updated = widest((row) => row.updated);
  const branches = widest((row) => row.branch);
  return rows
    .map((row) => `${row.id.padEnd(ids)}  ${row.updated.padEnd(updated)}  ${row.branch.padEnd(branches)}  ${row.title}\n`)
    .join('');
}

/** What is said, on stderr, when the listing is empty. */
export function nothingHere(cwd: string, all: boolean): string {
  return all
    ? 'No stored conversations for these accounts.\n'
    : `No stored conversations in ${cwd}. Try artemis ls --all.\n`;
}

/**
 * Read the conversations and write them. Resolves to the process exit code.
 *
 * A store that cannot be read fails the command rather than printing a shorter
 * list quietly — the rail can afford to leave itself as it was, but a script
 * that pipes this into `xargs` needs to be told that what it got is not the
 * answer.
 */
export async function runSessionsList(launched: Launched, options: ListOptions, io: SessionsIo): Promise<number> {
  const { host, settings } = launched;
  let sessions: readonly SessionSummary[];
  try {
    const accounts = (await host.profiles.listMetadata()).filter((profile) => profile.disabled !== true);
    sessions = await host.listSessionsAcross(accounts.map((profile) => ({ id: profile.id, providerId: profile.providerId })));
  } catch (error) {
    io.stderr(`Could not read stored conversations: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const listed = selectSessions(sessions, settings.cwd, options.all);
  if (options.json) {
    io.stdout(sessionsJsonl(listed));
    return 0;
  }
  // Nothing found is not a failure, and the sentence about it belongs on
  // stderr: a pipe that expected rows should see no rows, not prose.
  if (listed.length === 0) io.stderr(nothingHere(settings.cwd, options.all));
  else io.stdout(sessionsTable(listed));
  return 0;
}
