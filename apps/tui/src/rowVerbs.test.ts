/**
 * A row's verbs: what each kind of row offers, and what the verbs act on.
 *
 * Built from events through the model rather than from hand-written items, so
 * the shapes under test are the ones a provider actually produces — an `Edit`
 * is recognised by its arguments and diffed by the same code the row draws
 * with, and a run's calls are folded into a group by the same rule.
 */

import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@rx-artemis/protocol';
import {
  TranscriptModel,
  isGroupId,
  syncScheduler,
  type ActivityGroup,
  type TranscriptItem,
} from '@rx-artemis/transcript';

import { rowCommand, rowTarget, rowVerbHint, rowVerbs, rowYankText } from './rowVerbs.js';

/** Envelope filler; timestamps rise with position. */
function stream(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): AgentEvent[] {
  return drafts.map((draft, index) => ({ ...draft, runId: 'run_1', seq: index, ts: 1000 + index })) as AgentEvent[];
}

function model(events: readonly AgentEvent[]): TranscriptModel {
  const transcript = new TranscriptModel(syncScheduler);
  for (const event of events) transcript.apply(event);
  transcript.flush();
  return transcript;
}

/** The nth item the model holds, which is not the nth row once things fold. */
function itemAt(transcript: TranscriptModel, index: number): TranscriptItem {
  const id = transcript.getListSnapshot()[index];
  const item = id === undefined ? undefined : transcript.getItem(id);
  if (item === undefined) throw new Error(`no item at ${String(index)}`);
  return item;
}

function onlyGroup(transcript: TranscriptModel): ActivityGroup {
  const id = transcript.getRowsSnapshot().find((row) => isGroupId(row));
  const group = id === undefined ? undefined : transcript.getGroup(id);
  if (group === undefined) throw new Error('no group');
  return group;
}

const keysOf = (row: Parameters<typeof rowVerbs>[0]): string[] => rowVerbs(row).map((verb) => verb.key);

describe('the verbs a row offers', () => {
  it('gives an edit the file, the diff and the text', () => {
    const transcript = model(
      stream({
        type: 'tool.start',
        toolCallId: 'e1',
        name: 'Edit',
        input: { file_path: 'src/app/theme.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
      }),
    );
    const verbs = rowVerbs(itemAt(transcript, 0));

    // The basename, not the path: the hint is one line and the row above it
    // is already showing the whole path.
    expect(verbs).toContainEqual({ key: 'o', label: 'open theme.ts', kind: 'open' });
    expect(verbs.map((verb) => verb.kind)).toEqual(['open', 'diff', 'yank', 'stop']);
  });

  it('offers to re-run a command, and nothing to open', () => {
    const transcript = model(
      stream(
        { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'pnpm test' } },
        { type: 'tool.end', toolCallId: 'c1', status: 'error', error: { message: 'exit code 1' } },
      ),
    );

    expect(keysOf(itemAt(transcript, 0))).toEqual(['r', 'y']);
    expect(rowCommand(itemAt(transcript, 0))).toBe('pnpm test');
  });

  it('leaves a plain reply with the one verb every row has', () => {
    const transcript = model(stream({ type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'On it.' }));
    const verbs = rowVerbs(itemAt(transcript, 0));

    expect(verbs).toEqual([{ key: 'y', label: 'yank', kind: 'yank' }]);
    expect(rowYankText(itemAt(transcript, 0))).toBe('On it.');
  });

  it('offers to unfold a run that is holding calls behind its count', () => {
    const transcript = model(
      stream(
        { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool.end', toolCallId: 'c1', status: 'ok', resultText: 'README.md' },
        { type: 'tool.start', toolCallId: 'c2', name: 'Read', input: { file_path: 'README.md' } },
        { type: 'tool.end', toolCallId: 'c2', status: 'ok', resultText: '# Artemis' },
      ),
    );

    expect(keysOf(onlyGroup(transcript))).toEqual(['y', 'Enter']);
  });

  it('does not offer to unfold a run that is already drawn in full', () => {
    // Every call failed, and a failure is never folded away: there is nothing
    // behind the count, so the key would promise a view that never changes.
    const transcript = model(
      stream(
        { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'false' } },
        { type: 'tool.end', toolCallId: 'c1', status: 'error', error: { message: 'exit code 1' } },
      ),
    );

    expect(keysOf(onlyGroup(transcript))).toEqual(['y']);
  });

  it('offers to stop a call that is still running, and a run with one in it', () => {
    const transcript = model(stream({ type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'sleep 100' } }));

    expect(keysOf(itemAt(transcript, 0))).toEqual(['r', 'y', 'x']);
    expect(keysOf(onlyGroup(transcript))).toEqual(['y', 'x']);
  });

  it('offers to unfold a result the row would cut', () => {
    const transcript = model(
      stream(
        { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool.end', toolCallId: 'c1', status: 'ok', resultText: 'one\ntwo\nthree\nfour\nfive\nsix' },
      ),
    );

    expect(keysOf(itemAt(transcript, 0))).toEqual(['r', 'y', 'Enter']);
  });

  it('leaves a result that fits without one', () => {
    const transcript = model(
      stream(
        { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool.end', toolCallId: 'c1', status: 'ok', resultText: 'one\ntwo' },
      ),
    );

    expect(keysOf(itemAt(transcript, 0))).toEqual(['r', 'y']);
  });
});

describe('the hint the verbs print as', () => {
  it('is the keys and what they do, in the order they were given', () => {
    expect(
      rowVerbHint([
        { key: 'o', label: 'open', kind: 'open' },
        { key: 'd', label: 'diff', kind: 'diff' },
        { key: 'y', label: 'yank', kind: 'yank' },
        { key: 'Enter', label: 'unfold', kind: 'unfold' },
      ]),
    ).toBe('o open · d diff · y yank · Enter unfold');
  });

  it('is empty for a row with nothing to offer', () => {
    expect(rowVerbHint([])).toBe('');
  });
});

describe('where a row points', () => {
  it('gives an edit its path and the first line it changed', () => {
    // Five lines in, one line replaced. The number is the new file's, because
    // the new file is the one the editor is about to open.
    const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n');
    const after = ['one', 'two', 'three', 'four', 'CHANGED', 'six', 'seven'].join('\n');
    const transcript = model(
      stream({
        type: 'tool.start',
        toolCallId: 'e1',
        name: 'Edit',
        input: { file_path: 'src/components/Transcript.tsx', old_string: before, new_string: after },
      }),
    );

    expect(rowTarget(itemAt(transcript, 0))).toEqual({ path: 'src/components/Transcript.tsx', line: 5 });
  });

  it('gives a file that was read its path and no line', () => {
    const transcript = model(stream({ type: 'tool.start', toolCallId: 'r1', name: 'Read', input: { file_path: 'README.md' } }));

    expect(rowTarget(itemAt(transcript, 0))).toEqual({ path: 'README.md' });
  });

  it('gives a search nothing, whatever directory it names', () => {
    // A `path` argument on a Grep is a folder it looked in, and opening that
    // in an editor is not what anyone pressing `o` on the row meant.
    const transcript = model(
      stream({ type: 'tool.start', toolCallId: 'g1', name: 'Grep', input: { pattern: 'TODO', path: 'src' } }),
    );

    expect(rowTarget(itemAt(transcript, 0))).toBeNull();
    expect(keysOf(itemAt(transcript, 0))).toEqual(['y', 'x']);
  });

  it('gives a reply nothing at all', () => {
    const transcript = model(stream({ type: 'text.delta', messageId: 'm1', blockIndex: 0, text: 'On it.' }));

    expect(rowTarget(itemAt(transcript, 0))).toBeNull();
  });
});

describe('the command a row would re-run', () => {
  it('joins one sent as an argument list back into a line', () => {
    const transcript = model(
      stream({ type: 'tool.start', toolCallId: 'c1', name: 'shell', input: { command: ['pnpm', 'test'] } }),
    );

    expect(rowCommand(itemAt(transcript, 0))).toBe('pnpm test');
  });

  it('is the shell line a person ran themselves', () => {
    const transcript = model(
      stream({ type: 'command.run', source: 'shell', command: { name: 'git', args: 'status' } }),
    );

    expect(rowCommand(itemAt(transcript, 0))).toBe('git status');
  });

  it('is nothing for a slash command, which is not a shell line', () => {
    const transcript = model(stream({ type: 'command.run', command: { name: 'model', args: 'sonnet' } }));

    expect(rowCommand(itemAt(transcript, 0))).toBeNull();
  });
});

describe('a row as text', () => {
  it('takes an edit as a unified diff, which pastes into a review', () => {
    const transcript = model(
      stream({
        type: 'tool.start',
        toolCallId: 'e1',
        name: 'Edit',
        input: { file_path: 'notes.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
      }),
    );
    const text = rowYankText(itemAt(transcript, 0));

    expect(text).toContain('--- notes.ts');
    expect(text).toContain('+++ notes.ts');
    expect(text).toContain('-const a = 1;');
    expect(text).toContain('+const a = 2;');
  });

  it('takes a call as the line the row draws and everything it returned', () => {
    const transcript = model(
      stream(
        { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool.end', toolCallId: 'c1', status: 'ok', resultText: 'one\ntwo\nthree\nfour\nfive\nsix' },
      ),
    );

    // Nothing is folded: the fold is a property of a screen with a finite
    // number of lines, and the clipboard has none.
    expect(rowYankText(itemAt(transcript, 0))).toBe('Bash(ls)\none\ntwo\nthree\nfour\nfive\nsix');
  });

  it('takes a run as its summary and every call under it', () => {
    const transcript = model(
      stream(
        { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool.end', toolCallId: 'c1', status: 'ok', resultText: 'README.md' },
        { type: 'tool.start', toolCallId: 'c2', name: 'Read', input: { file_path: 'README.md' } },
        { type: 'tool.end', toolCallId: 'c2', status: 'ok', resultText: '# Artemis' },
      ),
    );
    const group = onlyGroup(transcript);
    const members = group.ids
      .map((id) => transcript.getItem(id))
      .filter((item): item is TranscriptItem => item !== undefined);
    const text = rowYankText(group, members);

    expect(text).toContain('Ran a command, read a file');
    expect(text).toContain('Bash(ls)');
    expect(text).toContain('README.md');
    expect(text).toContain('# Artemis');
  });
});
