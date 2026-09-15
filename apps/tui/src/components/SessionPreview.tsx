/**
 * What a conversation is, before you open it.
 *
 * A rail row is a title and, under the cursor, one dim line of when and where.
 * That is enough to walk a list and not enough to choose from one: two
 * conversations called "fix the tests" are told apart by the branch they ran
 * on, the folder they ran in and the thing that was actually asked. Space over
 * a row shows this box; nothing is loaded to draw it.
 *
 * Which is the limit worth stating plainly. This draws a `SessionSummary` —
 * the listing entry — and the listing carries exactly one piece of the
 * conversation's text, `firstPrompt`, the opening message. There is no field
 * for the agent's last line, so the box does not show one: reading it would
 * mean opening the transcript of every row the cursor passes over, which is
 * the cost this box exists to avoid. A conversation whose store kept no
 * opening prompt says so rather than leaving a blank where text should be.
 *
 * The lines are computed apart from the drawing, so the wrapping and the
 * shortening can be tested as arithmetic. The first is the title and the rest
 * are furniture, except the opening prompt, which is the one thing here worth
 * reading at full strength.
 */

import { homedir } from 'node:os';

import { Box, Text } from 'ink';
import type { SessionSummary } from '@rx-artemis/protocol';
import { formatRelative, oneLine } from '@rx-artemis/transcript';

import { shortenPath } from '../directories.js';
import { ACCENT } from '../theme.js';

/** How much of the opening prompt is shown before it is cut off. */
const MAX_PROMPT_LINES = 4;

/** Border and padding, which the text does not get to use. */
const CHROME = 4;

export interface PreviewLine {
  /** `title` is the name, `meta` the furniture, `body` the conversation's own words. */
  readonly kind: 'title' | 'meta' | 'body';
  readonly text: string;
}

export interface SessionPreviewProps {
  readonly session: SessionSummary;
  /** The width the box has to fit in, border included. */
  readonly columns: number;
  /** The home directory, for shortening the folder. Taken from the OS by default. */
  readonly home?: string;
}

/**
 * The box's contents, line by line.
 *
 * Everything the summary knows that helps tell one conversation from another:
 * when it was last touched, the branch and model it ran with, how long it got,
 * where it ran, and what was asked at the start. Fields the provider did not
 * record are left out rather than shown empty — a row of ` · · ` is noise
 * pretending to be information.
 */
export function previewLines(session: SessionSummary, columns: number, home: string = homedir()): readonly PreviewLine[] {
  const width = Math.max(16, columns - CHROME);
  const lines: PreviewLine[] = [{ kind: 'title', text: oneLine(session.title, width) }];

  const facts = [
    formatRelative(session.updatedAt),
    session.gitBranch,
    session.model,
    session.messageCount === undefined ? undefined : `${String(session.messageCount)} messages`,
  ].filter((part): part is string => part !== undefined && part.length > 0);
  if (facts.length > 0) lines.push({ kind: 'meta', text: oneLine(facts.join(' · '), width) });

  lines.push({ kind: 'meta', text: oneLine(shortenPath(session.cwd, home), width) });

  const prompt = session.firstPrompt === undefined ? '' : oneLine(session.firstPrompt, width * MAX_PROMPT_LINES);
  if (prompt.length === 0) {
    lines.push({ kind: 'meta', text: 'no opening prompt stored' });
    return lines;
  }
  lines.push({ kind: 'meta', text: 'first prompt' });
  for (const line of wrap(prompt, width, MAX_PROMPT_LINES)) lines.push({ kind: 'body', text: line });
  return lines;
}

/**
 * `text` broken at spaces to fit `width`, at most `maxLines` of it.
 *
 * A word longer than the line — a path, a stack frame — is cut rather than
 * allowed to overflow, because a box that grows sideways breaks the layout it
 * is drawn into.
 */
function wrap(text: string, width: number, maxLines: number): readonly string[] {
  const lines: string[] = [];
  let rest = text;
  while (rest.length > 0 && lines.length < maxLines) {
    if (rest.length <= width) {
      lines.push(rest);
      return lines;
    }
    const slice = rest.slice(0, width + 1);
    const cut = slice.lastIndexOf(' ');
    const take = cut > Math.floor(width / 2) ? cut : width;
    lines.push(rest.slice(0, take).trimEnd());
    rest = rest.slice(take).trimStart();
  }
  // Something is left over: the last line says so rather than stopping mid-word.
  if (rest.length > 0) {
    const last = lines.pop() ?? '';
    lines.push(oneLine(`${last}…`, width));
  }
  return lines;
}

export function SessionPreview({ session, columns, home }: SessionPreviewProps): React.JSX.Element {
  const lines = previewLines(session, columns, home ?? homedir());
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={columns}>
      {lines.map((line, index) => (
        <Text
          key={`${line.kind}:${String(index)}`}
          bold={line.kind === 'title'}
          color={line.kind === 'title' ? ACCENT : undefined}
          dimColor={line.kind === 'meta'}
          wrap="truncate-end"
        >
          {line.text}
        </Text>
      ))}
    </Box>
  );
}
