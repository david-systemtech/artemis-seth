/**
 * Everyone who is waiting on you, in one card.
 * ============================================================================
 *
 *     ╭──────────────────────────────────────────────────────╮
 *     │ ⚿ 3 conversations are waiting on you                 │
 *     │                                                      │
 *     │ ❯ fix the tests (here)  Bash rm -rf build            │
 *     │   api migration         question Which database?     │
 *     │   docs pass             Write docs/adr/0002.md       │
 *     │                                                      │
 *     │ ↑↓ move · Enter open · y allow once · n deny · a/N …  │
 *     ╰──────────────────────────────────────────────────────╯
 *
 * Ctrl+] walks to whoever is waiting, one press per conversation. That is the
 * right answer for one and the wrong one for four: each press replaces the
 * screen with a transcript nobody came to read, so answering four parked asks
 * costs four context switches and leaves you somewhere you have to navigate
 * back from. The count on the status line says "4 awaiting you" and the only
 * thing it can offer is the tour.
 *
 * So when more than one conversation is parked, the jump opens this instead: a
 * list of what each of them wants, answerable in place. Three of four asks are
 * a `Bash` line or an edit whose whole decision is "yes, go on" — those are
 * `y` and `n` from here, and the run continues without the screen moving. The
 * fourth is the one worth reading, and Enter goes there.
 *
 * ## What this card is not allowed to become
 *
 * A surface that answers four permission requests at once is a surface that
 * can get four of them wrong at once, so it carries `PermissionCard`'s safety
 * rules and tightens one of them.
 *
 *  - **Nothing here is a default that authorises.** The cursor opens on the
 *    first row and Enter *opens the conversation*; there is no keystroke that
 *    allows something by being pressed once more than intended.
 *  - **Esc decides nothing.** This is the one place the other card's rule is
 *    inverted on purpose. Esc denies on `PermissionCard` because that card is
 *    one request and leaving it unanswered is itself an answer. Four rows are
 *    four conversations, and a key that denied all of them on the way out
 *    would be four decisions nobody made. Here Esc closes, and everything it
 *    was showing is still parked and still answerable.
 *  - **Everything but yes-and-no needs the full card.** A rule to save, a
 *    scope to narrow, a sentence to deny with, a plan to read — none of it is
 *    offered here, because a row three inches wide cannot show what a rule
 *    would write down, and `PermissionCard` exists and says so under every
 *    row. `y` and `n` are exactly the two answers that need no more context
 *    than the line already on screen; Enter is the way to every other answer.
 *  - **A question and a plan can only be opened.** An interview's answer is
 *    which option, not yes, and a plan's yes is a mode change. Those rows say
 *    `question` or `plan` in the colour of the card they open into, and they
 *    ignore `y` and `n` rather than pretending to a shortcut that would have
 *    to invent an answer.
 *  - **`a` and `N` stand behind a confirm row.** Allowing every tool call in
 *    the pool at once is worth typing twice, so the legend becomes `allow all
 *    3 once? y/n` and the keys do nothing until it is answered. They appear
 *    only when there are two or more approvals to act on — with one row left
 *    the bulk key is a second name for `y`, and two names for one answer is
 *    how somebody allows a thing they meant to read.
 *
 * ## A decided row leaves at once
 *
 * The row is struck from the list here rather than waiting for the pool to say
 * so. The answer goes out over the wire, the conversation's state comes back
 * some frames later, and a row that lingered in between is a row that can be
 * allowed twice by somebody pressing `y` at the speed of a list they have
 * already read. The card closes itself when the last row goes, because a
 * bordered box saying nothing is waiting is a thing to dismiss by hand.
 *
 * ## The current conversation is in the list
 *
 * Its own card is already on screen behind this one, so listing it looks like
 * duplication — and leaving it out is worse. The status line's count includes
 * it; a card headed "3 conversations are waiting on you" that lists two is a
 * card whose count you stop trusting. It carries `(here)` so the row is
 * recognisable, answers `y` and `n` like any other, and Enter on it simply
 * closes the card and uncovers the full card underneath.
 *
 * ## Why this draws its own list
 *
 * `Picker` owns a selection and reports a chosen row; this needs a cursor that
 * three different keys read, a per-row answer to whether those keys apply, and
 * a legend that changes with the row under it. `PermissionCard` mirrors the
 * picker's arrows for the same reason and says so. The rows here are one line
 * each with a bold name and a dim tail, which is less drawing than the
 * mirroring would have been.
 */

import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { PermissionDecision, PermissionRequest } from '@rx-artemis/protocol';
import { oneLine, summarizeToolInput } from '@rx-artemis/transcript';

import { DEFAULT_DENIAL } from './PermissionCard.js';

/** Which of the three things a `permission.request` carries this row is. */
export type AskKind = 'approval' | 'question' | 'plan';

/** One parked conversation, as the app hands it over. */
export interface Ask {
  /** The pool's key for the conversation, and the row's identity. */
  readonly key: string;
  /** The conversation's name, as the rail draws it. */
  readonly title: string;
  readonly request: PermissionRequest;
  /** Answer it where it is parked. */
  readonly decide: (decision: PermissionDecision) => void;
  /** Switch to it, so the full card can be answered. */
  readonly open: () => void;
  /** The conversation on screen behind this card. */
  readonly current?: boolean;
}

/** A row, with every piece already cut to the width it will be drawn at. */
export interface AskRow {
  readonly key: string;
  /** The conversation's name, shortened. */
  readonly title: string;
  readonly kind: AskKind;
  /** `question` or `plan`; empty for an approval, which needs no word. */
  readonly tag: string;
  /** What the conversation is being asked. */
  readonly detail: string;
  /** Whether `y` and `n` mean anything on this row. */
  readonly decidable: boolean;
  readonly current: boolean;
}

/** Two borders, two columns of padding, and the two-cell cursor gutter. */
const CHROME = 6;
/** The longest a conversation's name is drawn before it is cut. */
const MAX_TITLE = 28;
/** The least the ask's own words are given, however narrow the terminal. */
const MIN_DETAIL = 12;
/** Drawn after the name of the conversation this card is sitting on top of. */
const HERE = ' (here)';
/** The two spaces between the name and the ask. */
const GAP = 2;

const kindOf = (request: PermissionRequest): AskKind =>
  request.plan !== undefined ? 'plan' : request.question !== undefined ? 'question' : 'approval';

/**
 * The sentence the row shows.
 *
 * The provider's own `title` first — the protocol asks for it to be preferred
 * over anything reconstructed from the arguments, and `PermissionCard` reads
 * it the same way, so the line here and the line on the full card are the same
 * line. Without one it is the tool and whichever argument `summarizeToolInput`
 * finds most telling, which is the command for a `Bash` and the path for an
 * edit.
 *
 * A question is the exception: its title is the provider announcing that it
 * has a question, and the thing worth reading in a list of four is the
 * question itself.
 */
function describeAsk(request: PermissionRequest, kind: AskKind): string {
  if (kind === 'question') {
    const first = request.question?.questions[0];
    if (first !== undefined) return first.question;
  }
  return request.title ?? `${request.toolName} ${summarizeToolInput(request.input)}`.trim();
}

/**
 * The rows, fitted to the card's width.
 *
 * The name gets up to a third of the line and never more than {@link
 * MAX_TITLE}: the names are what the eye walks down and they have to line up
 * near enough to read as a column, while the ask is the part that is worth
 * whatever room is left. Both are cut here rather than left to Ink's
 * `truncate`, so that what a row says can be tested as text.
 */
export function askRows(asks: readonly Ask[], columns: number): readonly AskRow[] {
  const room = Math.max(MIN_DETAIL, Math.floor(columns) - CHROME);
  const titleRoom = Math.max(8, Math.min(MAX_TITLE, Math.floor(room / 3)));
  return asks.map((ask) => {
    const kind = kindOf(ask.request);
    const tag = kind === 'approval' ? '' : kind;
    const current = ask.current === true;
    const title = oneLine(ask.title, titleRoom);
    const spent = title.length + (current ? HERE.length : 0) + GAP + (tag.length > 0 ? tag.length + 1 : 0);
    return {
      key: ask.key,
      title,
      kind,
      tag,
      detail: oneLine(describeAsk(ask.request, kind), Math.max(MIN_DETAIL, room - spent)),
      decidable: kind === 'approval',
      current,
    };
  });
}

/** The card's title line, which has to survive the list draining to one. */
export function asksHeading(count: number): string {
  return count === 1 ? '1 conversation is waiting on you' : `${String(count)} conversations are waiting on you`;
}

/** The colour of the card a row opens into, so the tag points at where it goes. */
const TAG_COLOUR: Readonly<Record<AskKind, string>> = {
  approval: 'yellow',
  question: 'magenta',
  plan: 'blue',
};

/** The bulk key that has been pressed and is waiting to be confirmed. */
type Confirm = 'allow-all' | 'deny-all';

const ALLOW_ONCE: PermissionDecision = { behavior: 'allow', scope: 'once' };
const DENY: PermissionDecision = { behavior: 'deny', message: DEFAULT_DENIAL };

export interface AsksCardProps {
  /** One per pooled conversation with a pending permission, in rail order. */
  readonly asks: readonly Ask[];
  /** The columns the card may fill, borders included. */
  readonly columns: number;
  readonly onClose: () => void;
  /** Off while something in front of this owns the keyboard. */
  readonly isActive?: boolean;
}

export function AsksCard({ asks, columns, onClose, isActive = true }: AsksCardProps): React.JSX.Element | null {
  /*
   * The rows already answered from here. Kept rather than derived because the
   * answer is a round trip: `decide` sends it, the pool hears back some frames
   * later, and until it does the prop still holds the row.
   */
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const live = asks.filter((ask) => !settled.has(ask.key));
  const rows = askRows(live, columns);
  const at = rows.length === 0 ? 0 : Math.max(0, Math.min(cursor, rows.length - 1));
  const row = rows[at];
  const ask = live[at];
  const bulk = live.filter((candidate) => kindOf(candidate.request) === 'approval');
  const empty = rows.length === 0;

  /*
   * Closing on an empty list, once. The callback is read from a ref because
   * every caller will pass an inline arrow, and an arrow in the dependencies
   * is a new effect on every render — which here would mean calling `onClose`
   * on every render rather than on the render the list ran out.
   */
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (empty) close.current();
  }, [empty]);

  const move = (delta: number): void => {
    setCursor((current) => {
      const count = rows.length;
      if (count === 0) return 0;
      return (Math.max(0, Math.min(current, count - 1)) + delta + count) % count;
    });
  };

  /*
   * The cursor is left where it is, so a decided row drops out from under it
   * and the next one arrives beneath it. Walking a list of asks top to bottom
   * with `y` is the thing this card is for, and a cursor that jumped home
   * after every answer would make that four presses of Down.
   */
  const decideOne = (target: Ask, decision: PermissionDecision): void => {
    target.decide(decision);
    setSettled((current) => new Set(current).add(target.key));
  };

  /** Every approval row at once. Questions and plans stay; they have no yes. */
  const decideAll = (decision: PermissionDecision): void => {
    for (const target of bulk) target.decide(decision);
    setSettled((current) => {
      const next = new Set(current);
      for (const target of bulk) next.add(target.key);
      return next;
    });
  };

  useInput(
    (input, key) => {
      if (confirm !== null) {
        /*
         * The confirm row has the keyboard and answers two keys. Esc and `n`
         * back out of it — out of the confirmation, not out of the card, since
         * the key that gets you out of a mistake must never be the key that
         * commits one — and anything else is ignored rather than guessed at.
         */
        if (input === 'y') decideAll(confirm === 'allow-all' ? ALLOW_ONCE : DENY);
        if (input === 'y' || input === 'n' || key.escape) setConfirm(null);
        return;
      }
      if (key.escape) {
        onClose();
        return;
      }
      if (key.upArrow) {
        move(-1);
        return;
      }
      if (key.downArrow) {
        move(1);
        return;
      }
      if (ask === undefined || row === undefined) return;
      if (key.return) {
        // Open, then close: the full card is what takes over, and this one
        // standing in front of it would be two surfaces for one request.
        ask.open();
        onClose();
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input === 'a' || input === 'N') {
        if (bulk.length > 1) setConfirm(input === 'a' ? 'allow-all' : 'deny-all');
        return;
      }
      if (!row.decidable) return;
      if (input === 'y') {
        decideOne(ask, ALLOW_ONCE);
        return;
      }
      if (input === 'n') decideOne(ask, DENY);
    },
    { isActive },
  );

  if (empty) return null;

  const legend =
    confirm !== null
      ? confirm === 'allow-all'
        ? `allow all ${String(bulk.length)} once? y/n`
        : `deny all ${String(bulk.length)}? y/n`
      : row?.decidable === true
        ? `↑↓ move · Enter open · y allow once · n deny${
            bulk.length > 1 ? ' · a allow all · N deny all' : ''
          } · Esc closes, deciding nothing`
        : '↑↓ move · Enter open · this one is answered on its own card · Esc closes, deciding nothing';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow" bold>
        ⚿ {asksHeading(rows.length)}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((item, index) => {
          const selected = index === at;
          return (
            <Text key={item.key} wrap="truncate">
              {/* The gutter is two cells on every row, drawn or not, so that
                  nothing slides sideways as the cursor passes over it. */}
              <Text color="yellow">{selected ? '❯ ' : '  '}</Text>
              <Text bold={selected}>{item.title}</Text>
              {item.current && <Text dimColor>{HERE}</Text>}
              <Text>{' '.repeat(GAP)}</Text>
              {item.tag.length > 0 && <Text color={TAG_COLOUR[item.kind]}>{item.tag} </Text>}
              <Text dimColor={!selected}>{item.detail}</Text>
            </Text>
          );
        })}
      </Box>
      <Text color={confirm === null ? undefined : 'yellow'} dimColor={confirm === null}>
        {legend}
      </Text>
    </Box>
  );
}
