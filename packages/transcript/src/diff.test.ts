/**
 * The file-edit diff.
 *
 * Pure logic with no DOM, so it is tested directly rather than through the
 * component. Three properties matter and each has a way of silently going
 * wrong:
 *
 *  1. **Detection is by argument shape, not tool name.** If it ever starts
 *     keying on `"Edit"`, the next provider's editor tool renders as a JSON
 *     dump and nobody notices until someone tries it.
 *  2. **The diff is correct and minimal.** A diff that shows more changed lines
 *     than actually changed trains the reader to skim it, which defeats the
 *     point of showing it before an agent writes to disk.
 *  3. **It is bounded.** This runs inside a transcript row while a run streams.
 */

import { describe, expect, it } from 'vitest';
import { detectFileEdit, detectFileEdits, type DiffRow } from './diff.js';

/** Just the changed lines, as `+`/`−` prefixed text. */
function changes(rows: readonly DiffRow[]): string[] {
  return rows
    .filter((r) => r.kind === 'add' || r.kind === 'del')
    .map((r) => `${r.kind === 'add' ? '+' : '-'}${r.text}`);
}

describe('detection', () => {
  it('recognises an edit from its before/after pair', () => {
    const edit = detectFileEdit('Edit', {
      file_path: '/w/src/a.ts',
      old_string: 'const a = 1;',
      new_string: 'const a = 2;',
    });
    expect(edit).not.toBeNull();
    expect(edit?.path).toBe('/w/src/a.ts');
    expect(edit?.extension).toBe('ts');
  });

  /**
   * The property that keeps this provider-neutral. `apply_patch` with
   * `before`/`after` is not a tool Artemis ships today; it is the shape a
   * different CLI would plausibly use, and it must work without a code change.
   */
  it('recognises an unfamiliar tool that uses a known argument shape', () => {
    const edit = detectFileEdit('apply_patch', {
      path: 'src/main.rs',
      before: 'fn main() {}',
      after: 'fn main() { run(); }',
    });
    expect(edit).not.toBeNull();
    expect(edit?.extension).toBe('rs');
  });

  it('treats whole content on a writing tool as an all-new file', () => {
    const edit = detectFileEdit('Write', { file_path: '/w/new.md', content: 'a\nb\nc' });
    expect(edit?.whole).toBe(true);
    expect(edit?.added).toBe(3);
    expect(edit?.removed).toBe(0);
  });

  it('does not treat a read as an edit just because it carries content', () => {
    expect(detectFileEdit('Read', { file_path: '/w/a.ts', content: 'whatever' })).toBeNull();
  });

  it('ignores a tool call with no path', () => {
    expect(detectFileEdit('Edit', { old_string: 'a', new_string: 'b' })).toBeNull();
  });

  it('ignores an "edit" whose halves are identical', () => {
    // Rendering an all-context diff would claim a change happened. Falling back
    // to the raw view says less, but says nothing false.
    expect(
      detectFileEdit('Edit', { file_path: '/w/a.ts', old_string: 'x', new_string: 'x' }),
    ).toBeNull();
  });

  it('ignores everything that is not an edit at all', () => {
    expect(detectFileEdit('Bash', { command: 'ls -la' })).toBeNull();
  });
});

describe('the diff itself', () => {
  it('marks only the lines that changed', () => {
    const edit = detectFileEdit('Edit', {
      file_path: 'a.txt',
      old_string: 'one\ntwo\nthree\nfour',
      new_string: 'one\nTWO\nthree\nfour',
    });
    expect(changes(edit?.rows ?? [])).toEqual(['-two', '+TWO']);
    expect(edit?.added).toBe(1);
    expect(edit?.removed).toBe(1);
  });

  it('keeps line numbers aligned across an insertion', () => {
    const edit = detectFileEdit('Edit', {
      file_path: 'a.txt',
      old_string: 'a\nc',
      new_string: 'a\nb\nc',
    });
    const rows = edit?.rows ?? [];
    const inserted = rows.find((r) => r.kind === 'add');
    expect(inserted?.text).toBe('b');
    expect(inserted?.newNo).toBe(2);
    // An inserted line has no counterpart in the original, so no old number.
    expect(inserted?.oldNo).toBeUndefined();
    // …and the line after it has shifted by one on the new side only.
    const tail = rows.filter((r) => r.kind === 'ctx').at(-1);
    expect(tail).toMatchObject({ text: 'c', oldNo: 2, newNo: 3 });
  });

  /**
   * A write has no original to count against, so the only number any row can
   * carry is the new one — and it has to start at 1. Numbering from the first
   * line is what lets a renderer put a gutter beside a `Write` at all; blank
   * numbers there would make new files the one case with no way to navigate.
   */
  it('numbers a written file from its first line', () => {
    const rows = detectFileEdit('Write', { file_path: 'new.md', content: 'a\nb\nc' })?.rows ?? [];
    expect(rows.map((r) => [r.kind, r.oldNo, r.newNo])).toEqual([
      ['add', undefined, 1],
      ['add', undefined, 2],
      ['add', undefined, 3],
    ]);
  });

  it('gives a deleted line its number in the old file and none in the new', () => {
    const rows = detectFileEdit('Edit', {
      file_path: 'a.txt',
      old_string: 'a\nb\nc',
      new_string: 'a\nc',
    })?.rows ?? [];
    expect(rows.find((r) => r.kind === 'del')).toMatchObject({ text: 'b', oldNo: 2 });
    expect(rows.find((r) => r.kind === 'del')?.newNo).toBeUndefined();
    // The line after the deletion sits on different numbers on the two sides.
    expect(rows.at(-1)).toMatchObject({ kind: 'ctx', text: 'c', oldNo: 3, newNo: 2 });
  });

  it('leaves a gap unnumbered but keeps the count it stands for', () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const gap = detectFileEdit('Edit', {
      file_path: 'a.txt',
      old_string: `${body}\nlast`,
      new_string: `${body}\nLAST`,
    })?.rows.find((r) => r.kind === 'gap');
    // A gap is not a line of the file, so no number belongs to it; `skipped` is
    // the only thing a renderer can say about it.
    expect(gap?.oldNo).toBeUndefined();
    expect(gap?.newNo).toBeUndefined();
    expect(gap?.skipped).toBeGreaterThan(0);
  });

  it('still numbers the rows it shows when the payload was too large to diff', () => {
    const huge = Array.from({ length: 21_000 }, (_, i) => `l${i}`).join('\n');
    const adds = detectFileEdit('Write', { file_path: 'huge.log', content: huge })?.rows.filter(
      (r) => r.kind === 'add',
    );
    expect(adds?.[0]?.newNo).toBe(1);
    expect(adds?.at(-1)?.newNo).toBe(adds?.length);
  });

  it('picks out the characters that changed within a modified line', () => {
    const edit = detectFileEdit('Edit', {
      file_path: 'a.ts',
      old_string: 'export const timeout = 1000;',
      new_string: 'export const timeout = 5000;',
    });
    const add = edit?.rows.find((r) => r.kind === 'add');
    expect(add?.spans).toBeDefined();
    const [start, end] = add?.spans?.[0] ?? [0, 0];
    // Exactly the digit that moved, not the whole line.
    expect(add?.text.slice(start, end)).toBe('5');
  });

  it('does not span-highlight a line that shares nothing with its counterpart', () => {
    const edit = detectFileEdit('Edit', {
      file_path: 'a.txt',
      old_string: 'aaaa',
      new_string: 'zzzz',
    });
    // Highlighting the whole line adds nothing over the row's own colour.
    expect(edit?.rows.find((r) => r.kind === 'add')?.spans).toEqual([]);
  });

  it('collapses long runs of unchanged lines into a gap', () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const edit = detectFileEdit('Edit', {
      file_path: 'a.txt',
      old_string: `${body}\nlast`,
      new_string: `${body}\nLAST`,
    });
    const rows = edit?.rows ?? [];
    expect(rows.some((r) => r.kind === 'gap')).toBe(true);
    // A 61-line file with a one-line change must not render 61 rows.
    expect(rows.length).toBeLessThan(12);
  });
});

describe('bounds', () => {
  it('stays cheap on a large file with a small change', () => {
    const big = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join('\n');
    const started = Date.now();
    const edit = detectFileEdit('Edit', {
      file_path: 'big.txt',
      old_string: `${big}\ntail`,
      new_string: `${big}\nTAIL`,
    });
    // The affix stripping is what makes this linear; without it the LCS table
    // would be 25 million cells and this would be seconds, inside a row that
    // re-renders while a run streams.
    expect(Date.now() - started).toBeLessThan(500);
    expect(changes(edit?.rows ?? [])).toEqual(['-tail', '+TAIL']);
  });

  it('caps the rendered rows and says so', () => {
    const oldText = Array.from({ length: 4_000 }, (_, i) => `old ${i}`).join('\n');
    const newText = Array.from({ length: 4_000 }, (_, i) => `new ${i}`).join('\n');
    const edit = detectFileEdit('Edit', {
      file_path: 'huge.txt',
      old_string: oldText,
      new_string: newText,
    });
    expect(edit?.truncated).toBe(true);
    expect(edit?.rows.length).toBeLessThanOrEqual(600);
  });

  it('refuses to diff a payload past the line ceiling, without throwing', () => {
    const huge = Array.from({ length: 21_000 }, (_, i) => `l${i}`).join('\n');
    const edit = detectFileEdit('Write', { file_path: 'huge.log', content: huge });
    expect(edit?.truncated).toBe(true);
    expect(edit?.rows.length).toBeLessThan(100);
  });
});

/**
 * A multi-edit is several replacements to one file, applied in order, and the
 * tool never sends the file — only the fragments. So the diff is a
 * reconstruction, and the two things that can silently go wrong are the two
 * tested here: an edit that lands on an earlier edit's output must be folded
 * into it rather than shown as a second change, and an edit that lands
 * somewhere else must be stacked with the join made visible rather than
 * rendered as the next line of the same fragment.
 */
describe('several edits to one file', () => {
  it('folds a list of edits into one diff of one file', () => {
    const edit = detectFileEdit('MultiEdit', {
      file_path: '/w/src/server.ts',
      edits: [
        { old_string: 'const port = 3000;', new_string: 'const port = 8080;' },
        { old_string: 'app.listen(port);', new_string: 'app.listen(port, host);' },
        { old_string: 'export default app;', new_string: 'export default server;' },
      ],
    });

    expect(edit?.path).toBe('/w/src/server.ts');
    expect(edit?.extension).toBe('ts');
    expect(edit?.whole).toBe(false);
    expect(changes(edit?.rows ?? [])).toEqual([
      '-const port = 3000;',
      '+const port = 8080;',
      '-app.listen(port);',
      '+app.listen(port, host);',
      '-export default app;',
      '+export default server;',
    ]);
    expect(edit?.added).toBe(3);
    expect(edit?.removed).toBe(3);
    // Three fragments of one file are three regions, not nine adjacent lines.
    expect(edit?.rows.filter((r) => r.kind === 'gap')).toHaveLength(2);
  });

  it('chains an edit that lands on what an earlier edit produced', () => {
    const edit = detectFileEdit('MultiEdit', {
      file_path: 'a.ts',
      edits: [
        { old_string: 'let x = 1;', new_string: 'let x = 2;' },
        { old_string: 'let x = 2;', new_string: 'const x = 2;' },
      ],
    });

    // One region, showing where the file ended up — not the intermediate state,
    // which never existed on disk.
    expect(changes(edit?.rows ?? [])).toEqual(['-let x = 1;', '+const x = 2;']);
    expect(edit?.added).toBe(1);
    expect(edit?.removed).toBe(1);
    expect(edit?.rows.some((r) => r.kind === 'gap')).toBe(false);
  });

  it('replaces every occurrence when the edit says to', () => {
    const edit = detectFileEdit('MultiEdit', {
      file_path: 'a.ts',
      edits: [
        { old_string: 'const a = x;\nconst b = x;', new_string: 'let a = x;\nlet b = x;' },
        { old_string: 'x', new_string: 'y', replace_all: true },
      ],
    });

    expect(changes(edit?.rows ?? [])).toEqual([
      '-const a = x;',
      '-const b = x;',
      '+let a = y;',
      '+let b = y;',
    ]);
  });

  it('replaces only the first occurrence when it does not', () => {
    const edit = detectFileEdit('MultiEdit', {
      file_path: 'a.ts',
      edits: [
        { old_string: 'const a = x;\nconst b = x;', new_string: 'let a = x;\nlet b = x;' },
        { old_string: 'x', new_string: 'y' },
      ],
    });

    expect(changes(edit?.rows ?? [])).toEqual([
      '-const a = x;',
      '-const b = x;',
      '+let a = y;',
      '+let b = x;',
    ]);
  });

  it('stacks an edit it cannot locate rather than throwing', () => {
    const edit = detectFileEdit('MultiEdit', {
      file_path: 'a.ts',
      edits: [
        { old_string: 'one', new_string: 'ONE' },
        { old_string: 'nowhere in anything seen so far', new_string: 'somewhere' },
      ],
    });

    expect(changes(edit?.rows ?? [])).toEqual([
      '-one',
      '+ONE',
      '-nowhere in anything seen so far',
      '+somewhere',
    ]);
    // The join is a gap and not a size problem: nothing was clipped.
    expect(edit?.rows.filter((r) => r.kind === 'gap').map((r) => r.text)).toEqual([
      'elsewhere in the file',
    ]);
    expect(edit?.truncated).toBe(false);
  });

  it('keeps the line numbers of stacked regions ascending', () => {
    const rows =
      detectFileEdit('MultiEdit', {
        file_path: 'a.ts',
        edits: [
          { old_string: 'a\nb', new_string: 'a\nB' },
          { old_string: 'y\nz', new_string: 'Y\nz' },
        ],
      })?.rows ?? [];

    // A second region that restarted at 1 would give the gutter two line 1s and
    // no way to tell which is which.
    expect(rows.filter((r) => r.kind !== 'gap').map((r) => r.newNo ?? r.oldNo)).toEqual([
      1, 2, 2, 3, 3, 4,
    ]);
  });

  it('replaces text literally, even when it contains a dollar sign', () => {
    const edit = detectFileEdit('MultiEdit', {
      file_path: 'run.sh',
      edits: [
        { old_string: 'echo one', new_string: 'echo two' },
        { old_string: 'echo two', new_string: 'echo "$&" two' },
      ],
    });

    // `String.replace` would have expanded `$&` into the text it matched and
    // written a line the agent never asked for.
    expect(changes(edit?.rows ?? [])).toEqual(['-echo one', '+echo "$&" two']);
  });

  it('drops an edit that changes nothing', () => {
    const edit = detectFileEdit('MultiEdit', {
      file_path: 'a.ts',
      edits: [
        { old_string: 'same', new_string: 'same' },
        { old_string: 'one', new_string: 'two' },
      ],
    });

    expect(changes(edit?.rows ?? [])).toEqual(['-one', '+two']);
    expect(edit?.rows.some((r) => r.kind === 'gap')).toBe(false);
  });

  it('ignores an edit list with nothing usable in it', () => {
    expect(detectFileEdit('MultiEdit', { file_path: 'a.ts', edits: [] })).toBeNull();
    expect(detectFileEdit('MultiEdit', { file_path: 'a.ts', edits: [{ note: 'nope' }] })).toBeNull();
    expect(detectFileEdit('MultiEdit', { file_path: 'a.ts', edits: 'not a list' })).toBeNull();
    expect(
      detectFileEdit('MultiEdit', { file_path: 'a.ts', edits: [{ old_string: 'x', new_string: 'x' }] }),
    ).toBeNull();
  });
});

/** The `apply_patch` envelope, top to bottom: an update, an add, a delete, a move. */
const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/app.ts',
  '@@ function main',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' const c = 4;',
  '*** Add File: src/new.ts',
  "+export const hello = 'world';",
  '+export const bye = 0;',
  '*** Delete File: src/old.ts',
  '*** Update File: src/from.ts',
  '*** Move to: src/to.ts',
  '@@',
  '-const x = 1;',
  '+const x = 2;',
  '*** End Patch',
  '',
].join('\n');

describe('patches', () => {
  it('reads an update, an add, a delete and a move out of one patch', () => {
    const files = detectFileEdits('ApplyPatch', { patch: PATCH });

    expect(files.map((file) => [file.path, file.operation])).toEqual([
      ['src/app.ts', 'update'],
      ['src/new.ts', 'add'],
      ['src/old.ts', 'delete'],
      ['src/to.ts', 'update'],
    ]);

    const [updated, added, deleted, moved] = files;

    expect(changes(updated?.rows ?? [])).toEqual(['-const b = 2;', '+const b = 3;']);
    expect([updated?.added, updated?.removed]).toEqual([1, 1]);
    expect(updated?.whole).toBe(false);

    // An added file is whole new content, exactly as a write is, and its lines
    // are numbered from the first one for the same reason.
    expect(added?.whole).toBe(true);
    expect([added?.added, added?.removed]).toEqual([2, 0]);
    expect(added?.rows.map((r) => [r.kind, r.oldNo, r.newNo])).toEqual([
      ['add', undefined, 1],
      ['add', undefined, 2],
    ]);

    // A deleted file arrives with no content at all. `operation` is the only
    // thing that distinguishes it from a file nothing happened to.
    expect(deleted?.rows).toEqual([]);
    expect([deleted?.added, deleted?.removed]).toEqual([0, 0]);
    expect(deleted?.summaryOnly).toBeUndefined();

    expect(moved?.renamedFrom).toBe('src/from.ts');
    expect(changes(moved?.rows ?? [])).toEqual(['-const x = 1;', '+const x = 2;']);
  });

  it('reports the first file of a patch through the singular form', () => {
    expect(detectFileEdit('ApplyPatch', { patch: PATCH })?.path).toBe('src/app.ts');
  });

  it('shows the section a hunk anchor names, in place of the lines it skipped', () => {
    const gap = detectFileEdits('ApplyPatch', { patch: PATCH })[0]?.rows[0];
    expect(gap).toEqual({ kind: 'gap', text: 'function main' });
  });

  it('leaves rows unnumbered when the patch carries no line numbers', () => {
    // `apply_patch` hunks have none, and a number invented here would send the
    // reader to the wrong line of the right file while looking authoritative.
    const rows = detectFileEdits('ApplyPatch', { patch: PATCH })[0]?.rows ?? [];
    expect(rows.every((row) => row.oldNo === undefined && row.newNo === undefined)).toBe(true);
  });

  it('numbers rows from a unified hunk header', () => {
    const [file] = detectFileEdits('ApplyPatch', {
      diff: [
        '--- a/src/lib.ts',
        '+++ b/src/lib.ts',
        '@@ -10,4 +10,4 @@ export function go() {',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 3;',
        ' const c = 4;',
        '',
      ].join('\n'),
    });

    expect(file?.path).toBe('src/lib.ts');
    expect(file?.rows.map((r) => [r.kind, r.oldNo, r.newNo])).toEqual([
      ['gap', undefined, undefined],
      ['ctx', 10, 10],
      ['del', 11, undefined],
      ['add', undefined, 11],
      ['ctx', 12, 12],
    ]);
    expect(file?.rows[0]).toMatchObject({ text: 'export function go() {', skipped: 9 });
  });

  it('parses a bare hunk against the path the call names', () => {
    const edit = detectFileEdit('ApplyPatch', {
      file_path: 'src/only.ts',
      diff: '@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;\n',
    });

    expect(edit?.path).toBe('src/only.ts');
    expect(changes(edit?.rows ?? [])).toEqual(['-const a = 1;', '+const a = 2;']);
    // The hunk starts at line 1, so there is nothing above it to stand for.
    expect(edit?.rows.some((r) => r.kind === 'gap')).toBe(false);
  });

  it('survives a patch that was cut off mid-hunk', () => {
    const files = detectFileEdits('ApplyPatch', {
      patch: '*** Begin Patch\n*** Update File: a.ts\n@@\n-const a = 1',
    });
    expect(files.map((file) => [file.path, file.removed])).toEqual([['a.ts', 1]]);
  });

  it('finds no files in a patch that describes none', () => {
    expect(detectFileEdits('ApplyPatch', { patch: '*** Begin Patch\n*** End Patch\n' })).toEqual([]);
  });

  it('caps the rows of an enormous patch and says so', () => {
    const huge = [
      '*** Begin Patch',
      '*** Add File: big.txt',
      ...Array.from({ length: 21_000 }, (_, i) => `+l${i}`),
      '*** End Patch',
    ].join('\n');
    const [file] = detectFileEdits('ApplyPatch', { patch: huge });

    expect(file?.truncated).toBe(true);
    expect(file?.rows.length).toBeLessThanOrEqual(600);
  });

  it('reads a git-style add and delete from their /dev/null headers', () => {
    const files = detectFileEdits('ApplyPatch', {
      diff: [
        'diff --git a/src/new.ts b/src/new.ts',
        '--- /dev/null',
        '+++ b/src/new.ts',
        '@@ -0,0 +1,2 @@',
        '+const a = 1;',
        '+const b = 2;',
        'diff --git a/src/gone.ts b/src/gone.ts',
        '--- a/src/gone.ts',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-const c = 3;',
        '-const d = 4;',
        '',
      ].join('\n'),
    });

    expect(files.map((file) => [file.path, file.operation, file.added, file.removed])).toEqual([
      ['src/new.ts', 'add', 2, 0],
      ['src/gone.ts', 'delete', 0, 2],
    ]);
    expect(files[0]?.whole).toBe(true);
    expect(files[1]?.whole).toBe(false);
  });

  it('stops at the end of the envelope', () => {
    // Whatever a provider appends after `*** End Patch` is prose about the
    // patch; a line of it that starts with `+` is not an added line.
    const [file] = detectFileEdits('ApplyPatch', {
      patch: [
        '*** Begin Patch',
        '*** Update File: a.ts',
        '@@',
        '-const a = 1;',
        '+const a = 2;',
        '*** End Patch',
        '+and that is what I did',
      ].join('\n'),
    });

    expect([file?.added, file?.removed]).toEqual([1, 1]);
  });

  it('reads an added line that looks like a header as content', () => {
    // An added file's body starts straight after the keyword, with no `@@`
    // between, so the first line is a line of the file however it begins.
    const [file] = detectFileEdits('ApplyPatch', {
      patch: ['*** Begin Patch', '*** Add File: notes.md', '+++ a heading', '+text', '*** End Patch'].join(
        '\n',
      ),
    });

    expect(file?.path).toBe('notes.md');
    expect(changes(file?.rows ?? [])).toEqual(['+++ a heading', '+text']);
  });

  it('does not read a written .patch file as a patch', () => {
    // The same characters under `content` are the file being written, not the
    // changes being made.
    const edit = detectFileEdit('Write', { file_path: 'fix.patch', content: PATCH });
    expect(edit?.path).toBe('fix.patch');
    expect(edit?.whole).toBe(true);
    expect(edit?.operation).toBeUndefined();
  });
});

describe('files named without a diff', () => {
  it('names each path of a paths-only call and says nothing more', () => {
    // What a Codex `ApplyPatch` arrives as today. Zero is what is known, not a
    // claim that nothing changed — hence `summaryOnly`.
    expect(detectFileEdits('ApplyPatch', { paths: ['src/a.ts', 'src/b.md'] })).toEqual([
      {
        path: 'src/a.ts',
        extension: 'ts',
        rows: [],
        added: 0,
        removed: 0,
        truncated: false,
        whole: false,
        summaryOnly: true,
      },
      {
        path: 'src/b.md',
        extension: 'md',
        rows: [],
        added: 0,
        removed: 0,
        truncated: false,
        whole: false,
        summaryOnly: true,
      },
    ]);
  });

  it('reads the kind of a change alongside its path', () => {
    const [file] = detectFileEdits('ApplyPatch', { changes: [{ path: 'gone.ts', kind: 'delete' }] });
    expect(file?.operation).toBe('delete');
    expect(file?.summaryOnly).toBe(true);
  });

  it('parses a per-file diff carried beside its path', () => {
    // Nothing emits this yet; it is the shape the adapter would produce by
    // passing `changes` through instead of mapping it down to paths.
    const [file] = detectFileEdits('ApplyPatch', {
      changes: [{ path: 'src/a.ts', kind: 'update', diff: '@@ -1,1 +1,1 @@\n-a\n+b\n' }],
    });
    expect(file?.summaryOnly).toBeUndefined();
    expect(changes(file?.rows ?? [])).toEqual(['-a', '+b']);
  });

  it('ignores a list of paths on a tool that does not mutate', () => {
    expect(detectFileEdits('Read', { paths: ['a.ts'] })).toEqual([]);
    expect(detectFileEdit('Read', { paths: ['a.ts'] })).toBeNull();
  });
});

describe('the plural form and the singular one', () => {
  it('returns exactly the edit the singular form returns', () => {
    const input = { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' };
    const files = detectFileEdits('Edit', input);
    expect(files).toHaveLength(1);
    expect(files[0]).toEqual(detectFileEdit('Edit', input));
  });

  it('returns nothing where the singular form returns null', () => {
    expect(detectFileEdits('Bash', { command: 'ls -la' })).toEqual([]);
    expect(detectFileEdits('Read', { file_path: '/w/a.ts', content: 'whatever' })).toEqual([]);
    expect(detectFileEdits('Edit', undefined)).toEqual([]);
  });

  it('leaves an ordinary edit exactly as it was', () => {
    // The fields added for patches are optional and none of them appears on the
    // shapes that already worked.
    expect(
      detectFileEdit('Edit', { file_path: 'a.ts', old_string: 'one', new_string: 'two' }),
    ).toStrictEqual({
      path: 'a.ts',
      extension: 'ts',
      rows: [
        { kind: 'del', text: 'one', oldNo: 1, spans: [] },
        { kind: 'add', text: 'two', newNo: 1, spans: [] },
      ],
      added: 1,
      removed: 1,
      truncated: false,
      whole: false,
    });
  });
});
