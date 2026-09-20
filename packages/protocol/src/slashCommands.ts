/**
 * Slash commands that are not the first thing in the message.
 * ============================================================================
 *
 * A provider honours a slash command in exactly one place: the front. The
 * Claude CLI's own test for "is this a command" is `text.trim().startsWith('/')`
 * and nothing more, so `tidy this up /artemis-skills:unslop` is prose — it
 * reaches the model as literal text, no command runs, and nothing anywhere says
 * so. That silence is the whole problem: the user typed a command, watched it
 * autocomplete, and got a turn that ignored it.
 *
 * People do not write that way. The command is the *verb* and it arrives when
 * the sentence needs it, which is often at the end — "rewrite the changelog
 * entry and /artemis-skills:unslop it". So the draft is rearranged on its way
 * out: the command is lifted to the front, and everything else the person wrote
 * follows it as arguments. {@link hoistSlashCommand} is that lift.
 *
 * ---------------------------------------------------------------------------
 * WHY THE KNOWN-COMMAND LIST IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 *
 * A leading slash is also how most of the filesystem is spelled. `look at
 * /etc/hosts`, `mounted at /mnt/user`, `a 3/4 split` — treating any of those as
 * a command would take a turn somewhere the user never asked to go, and a turn
 * is not undoable. So the lift fires only on a token that *exactly* names a
 * command the session reported. Nothing is guessed, nothing is corrected, and a
 * draft with no such token comes back byte-for-byte unchanged.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENCE
 * ---------------------------------------------------------------------------
 *
 * A draft whose first non-space character is `/` is already where the provider
 * looks, so it is returned untouched. That is what makes it safe to lift in
 * more than one place — the composer does it so the user can see the result in
 * the transcript, and the server does it again for clients that have no
 * composer — without the second pass undoing the first.
 */

/** One `/word` in a draft, and where it sits. */
export interface SlashToken {
  /** Everything after the slash. Empty the moment the slash is typed. */
  readonly name: string;
  /** Offset of the `/`. */
  readonly start: number;
  /** Offset one past the token's last character. */
  readonly end: number;
  /**
   * Nothing but whitespace stands before it.
   *
   * The distinction the menu needs: a leading slash is unambiguously a command
   * being typed, while one in the middle of a sentence is as likely to be a
   * path. See {@link SlashToken} users in the two composers.
   */
  readonly leading: boolean;
}

const isSpace = (character: string): boolean => character.length > 0 && /\s/u.test(character);

/**
 * The name without its slash, if it arrived wearing one.
 *
 * Providers are not consistent about this — the Claude CLI reports bare names
 * (`compact`, `artemis-skills:cerebro`) while some fixtures and mappers report
 * `/compact` — and a set built from the raw strings would miss half the
 * commands it was supposed to recognise.
 */
export function canonicalCommandName(reported: string): string {
  return reported.startsWith('/') ? reported.slice(1) : reported;
}

/**
 * The slash token the cursor is in, or `null`.
 *
 * Deliberately the same rule `mentionAt` uses for `@`: walk back to the nearest
 * whitespace and ask whether what starts there is a slash. That is what keeps
 * the `/` in `and/or` out of it — its slash is mid-token — while still allowing
 * slashes inside the token, which `/artemis-skills:code-review` does not need
 * but `/etc/hosts` has, and which the caller wants to see so it can decline to
 * offer anything for it.
 *
 * On the slash itself the cursor is not in a token yet: nothing has been typed
 * and the next keystroke may well be to its left. The name is the whole token
 * rather than the part before the cursor, so arrowing back into a command to
 * fix a letter does not narrow the menu to a prefix of it.
 */
export function slashTokenAt(text: string, cursor: number): SlashToken | null {
  if (cursor < 0 || cursor > text.length) return null;
  let start = cursor;
  while (start > 0 && !isSpace(text.charAt(start - 1))) start -= 1;
  if (text.charAt(start) !== '/' || cursor <= start) return null;
  let end = cursor;
  while (end < text.length && !isSpace(text.charAt(end))) end += 1;
  return {
    name: text.slice(start + 1, end),
    start,
    end,
    leading: text.slice(0, start).trim() === '',
  };
}

/**
 * Every slash token in a draft, in the order they appear.
 *
 * For the lift, which has no cursor to work from: it is looking for the one
 * token that names a real command, wherever the person put it.
 */
export function slashTokensIn(text: string): readonly SlashToken[] {
  const tokens: SlashToken[] = [];
  const pattern = /(?:^|\s)\/(\S*)/gu;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const name = match[1] ?? '';
    const start = match.index + match[0].length - name.length - 1;
    tokens.push({ name, start, end: start + name.length + 1, leading: text.slice(0, start).trim() === '' });
  }
  return tokens;
}

/**
 * The gap to leave where the token was.
 *
 * Closing the hole with a plain space would fold a multi-line prompt onto one
 * line the moment somebody put a command at the end of the first paragraph. So
 * whichever side of the removed token carried a line break wins, reproduced
 * verbatim; a command sitting between two words on one line leaves a space.
 */
function seam(before: string, after: string): string {
  const trailing = /\s*$/u.exec(before)?.[0] ?? '';
  const leading = /^\s*/u.exec(after)?.[0] ?? '';
  if (leading.includes('\n')) return leading;
  if (trailing.includes('\n')) return trailing;
  return ' ';
}

/** A draft and where to put the caret in it. */
export interface SlashInsertion {
  readonly text: string;
  readonly caret: number;
}

/**
 * Write a command over the token it was typed into, and say where the caret
 * goes.
 *
 * Over the token and nothing else, so the sentence around it survives — the
 * whole point of a menu that opens mid-draft. The command stays where the user
 * put it; {@link hoistSlashCommand} moves it on send, which is late enough that
 * what they are reading while they type is still their own sentence.
 *
 * The trailing space is the rest of it: every command that takes arguments
 * needs one next, and the ones that do not are unharmed by it — the provider
 * trims. It also means the menu closes on accept, because the caret stops being
 * inside a slash token, which is what makes the very next keypress send.
 *
 * Nothing is added in front of whitespace that is already there: a space is
 * reused rather than doubled, as `replaceMention` does for the `@` popup, and a
 * line break is left alone rather than pushed along by a space that would only
 * ever be trailing.
 */
export function writeSlashCommand(draft: string, token: SlashToken, name: string): SlashInsertion {
  // Canonicalised rather than trusted: a caller passing the provider's raw
  // string would otherwise write `//compact`.
  const written = `/${canonicalCommandName(name)}`;
  const after = draft.slice(token.end);
  const gap = /^\s/u.test(after) ? '' : ' ';
  // The caret steps over a reused space and stops short of a reused line break,
  // so the next keystroke lands on the line the user was writing on.
  const stride = after.startsWith(' ') ? 1 : gap.length;
  return {
    text: `${draft.slice(0, token.start)}${written}${gap}${after}`,
    caret: token.start + written.length + stride,
  };
}

/**
 * Move the command in this draft to the front, so the provider will run it.
 *
 * Returns the draft **unchanged** whenever there is nothing to do: no command
 * list, no token that names one, or a draft that already leads with a slash.
 * Only the first such token is lifted — a second one stays where it was typed,
 * because a turn runs one command and rewriting the rest of the sentence to
 * pretend otherwise would be a guess.
 *
 * `commands` is the list the session reported, in either spelling; see
 * {@link canonicalCommandName}.
 */
export function hoistSlashCommand(draft: string, commands: readonly string[] | undefined): string {
  if (commands === undefined || commands.length === 0) return draft;
  // Already at the front — and this is the branch that makes a second lift a
  // no-op, which is what lets the composer and the server both do it.
  if (draft.trimStart().startsWith('/')) return draft;

  const known = new Set(commands.map(canonicalCommandName));
  const token = slashTokensIn(draft).find((candidate) => known.has(candidate.name));
  if (token === undefined) return draft;

  const before = draft.slice(0, token.start);
  const after = draft.slice(token.end);
  const head = before.replace(/\s+$/u, '');
  const tail = after.replace(/^\s+/u, '');
  const rest = head === '' ? tail : tail === '' ? head : `${head}${seam(before, after)}${tail}`;
  return rest === '' ? `/${token.name}` : `/${token.name} ${rest}`;
}
