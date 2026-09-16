/**
 * Every case here is a real paste, or as near as a test file can get: a trace
 * copied out of a terminal, a diff copied out of `git show`, a log with the
 * timestamps a logger actually writes. The rules are a pile of heuristics, and
 * heuristics are only worth what the samples they were tuned against are
 * worth — a synthetic `{"a":1}` proves nothing about the half of a payload
 * somebody pastes at three in the morning.
 *
 * So the table runs in both directions. For each kind there is what it is, and
 * beside it the near miss that must *not* be it: a markdown rule that is not a
 * diff, a sentence beginning `Error:` that is not a log, a JavaScript object
 * literal that is not JSON, prose that is not code. A classifier that only
 * ever says yes is a classifier that says nothing.
 *
 * The last two groups are about the promises rather than the guesses. Nothing
 * here may throw, whatever it is handed — it runs inside a keystroke — and
 * nothing may read more of a paste than the sample it promised to read, which
 * is checked by hiding evidence in the middle of one and proving it was
 * ignored.
 */

import { describe, expect, it } from 'vitest';

import {
  MARKER_CHARS,
  SAMPLE_HEAD,
  SAMPLE_TAIL,
  classifyPaste,
  expandChip,
  fenceFor,
  fenced,
  insideFence,
  pasteMarker,
} from './pasteKind.js';

/* ------------------------------------------------------------------------ */
/* What people paste                                                         */
/* ------------------------------------------------------------------------ */

const NODE_TRACE = [
  'Error: connect ECONNREFUSED 127.0.0.1:5432',
  '    at connect (/code/repos/artemis/apps/tui/src/app.tsx:1442:19)',
  '    at Socket.emit (node:events:517:28)',
  '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1595:16)',
  '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
].join('\n');

const PYTHON_TRACE = [
  'Traceback (most recent call last):',
  '  File "/srv/app/server.py", line 88, in handle',
  '    return self.dispatch(request)',
  '  File "/srv/app/router.py", line 31, in dispatch',
  '    raise KeyError(name)',
  "KeyError: 'orders'",
].join('\n');

const GO_TRACE = [
  'panic: runtime error: index out of range [3] with length 3',
  '',
  'goroutine 1 [running]:',
  'main.handle(0xc000110000)',
  '\t/home/seth/src/api/handler.go:42 +0x1b5',
  'main.main()',
  '\t/home/seth/src/api/main.go:17 +0x38',
  'exit status 2',
].join('\n');

const JAVA_TRACE = [
  'Exception in thread "main" java.lang.NullPointerException',
  '\tat com.example.Server.handle(Server.java:88)',
  '\tat com.example.Server.start(Server.java:41)',
  '\tat com.example.Server.main(Server.java:12)',
].join('\n');

const GIT_DIFF = [
  'diff --git a/apps/tui/src/app.tsx b/apps/tui/src/app.tsx',
  'index 83db48f..bf2695c 100644',
  '--- a/apps/tui/src/app.tsx',
  '+++ b/apps/tui/src/app.tsx',
  '@@ -1440,7 +1440,7 @@ export function App(): JSX.Element {',
  '-  const rows = 3;',
  '+  const rows = 4;',
  '   return null;',
  'diff --git a/apps/tui/src/editor.ts b/apps/tui/src/editor.ts',
  '--- a/apps/tui/src/editor.ts',
  '+++ b/apps/tui/src/editor.ts',
  '@@ -10,3 +10,3 @@',
  '-export const MAX = 8;',
  '+export const MAX = 12;',
  ' ',
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,2 +1,2 @@',
  '-# Old',
  '+# New',
].join('\n');

const UNIFIED_DIFF = [
  '--- old/config.yml\t2026-09-15 10:00:00.000000000 +0800',
  '+++ new/config.yml\t2026-09-15 10:05:00.000000000 +0800',
  '@@ -3,6 +3,7 @@',
  ' server:',
  '-  port: 8080',
  '+  port: 9090',
  '+  tls: true',
  '   host: localhost',
].join('\n');

const JSON_PASTE = JSON.stringify(
  { id: 4, name: 'thing', tags: ['a', 'b'], nested: { ok: true, count: 12 }, missing: null },
  null,
  2,
);

/** Half a payload, which is how much of one usually reaches the clipboard. */
const JSON_CUT = ['{', '  "id": 4,', '  "name": "thing",', '  "tags": [', '    "a",', '    "b"', '  ],', '}'].join('\n');

const ISO_LOG = [
  '2026-09-15T08:12:01.221Z INFO  server listening on :8080',
  '2026-09-15T08:12:03.981Z DEBUG cache warm, 412 entries',
  '2026-09-15T08:12:04.002Z WARN  slow query took 1.4s',
  '2026-09-15T08:12:09.117Z ERROR upstream refused the connection',
  '2026-09-15T08:12:09.118Z INFO  retrying in 500ms',
].join('\n');

const BRACKET_LOG = [
  '[info] build started',
  '[warn] two copies of react in the graph',
  '[error] cannot resolve ./missing',
  '[info] build failed in 1.2s',
].join('\n');

const TS_CODE = [
  'export interface Chip {',
  '  readonly kind: PasteKind;',
  '  readonly label: string;',
  '}',
  '',
  'export function chipFor(text: string): Chip {',
  '  const kind = classify(text);',
  '  return { kind, label: kind };',
  '}',
].join('\n');

const PYTHON_CODE = [
  'import json',
  '',
  'class Router:',
  '    def __init__(self, routes):',
  '        self.routes = routes',
  '',
  '    def dispatch(self, request):',
  '        handler = self.routes[request.path]',
  '        return handler(request)',
].join('\n');

const GO_CODE = [
  'package main',
  '',
  'func handle(w http.ResponseWriter, r *http.Request) {',
  '\tbody, err := io.ReadAll(r.Body)',
  '\tif err != nil {',
  '\t\treturn',
  '\t}',
  '\tfmt.Println(string(body))',
  '}',
].join('\n');

const SHELL_CODE = ['#!/usr/bin/env bash', 'set -euo pipefail', 'for f in *.ts; do', '  echo "$f"', 'done'].join('\n');

const PROSE = [
  'I have been staring at this all morning and I am going in circles.',
  'The button works the first time and then stops, but only in the packaged build.',
  'There is nothing in the console, which is what makes it maddening.',
  'Any idea where to start looking?',
].join('\n');

const MARKDOWN = ['# Notes', '', '- one thing', '- another thing', '', '---', '', 'Prose after a rule.'].join('\n');

/* ------------------------------------------------------------------------ */

describe('classifyPaste: stack traces', () => {
  it('reads a Node trace, and names the first file it blames', () => {
    const found = classifyPaste(NODE_TRACE);
    expect(found.kind).toBe('stack-trace');
    expect(found.label).toBe('Node stack trace from app.tsx:1442');
    expect(found.source).toBe('/code/repos/artemis/apps/tui/src/app.tsx:1442');
  });

  it('reads a Python traceback by its File/line frames', () => {
    const found = classifyPaste(PYTHON_TRACE);
    expect(found.kind).toBe('stack-trace');
    expect(found.label).toBe('Python stack trace from server.py:88');
    expect(found.source).toBe('/srv/app/server.py:88');
  });

  it('reads a Go panic by its tab-indented frames', () => {
    const found = classifyPaste(GO_TRACE);
    expect(found.kind).toBe('stack-trace');
    expect(found.label).toBe('Go stack trace from handler.go:42');
    expect(found.source).toBe('/home/seth/src/api/handler.go:42');
  });

  it('reads a Java trace, whose frames carry a line but no column', () => {
    const found = classifyPaste(JAVA_TRACE);
    expect(found.kind).toBe('stack-trace');
    expect(found.label).toBe('Java stack trace from Server.java:88');
  });

  it('wants three frames, or two and something that says what threw', () => {
    const two = ['    at foo (/a/b.js:1:2)', '    at bar (/a/c.js:3:4)'].join('\n');
    expect(classifyPaste(two).kind).toBe('text');
    expect(classifyPaste(`TypeError: x is not a function\n${two}`).kind).toBe('stack-trace');
    expect(classifyPaste(`${two}\n    at baz (/a/d.js:5:6)`).kind).toBe('stack-trace');
  });

  it('prefers the trace inside a log, which is what the log was pasted for', () => {
    const mixed = ['2026-09-15T08:12:09.117Z ERROR upstream refused', NODE_TRACE].join('\n');
    expect(classifyPaste(mixed).kind).toBe('stack-trace');
  });

  it('is not fooled by a sentence that happens to mention an error', () => {
    const asking = [
      'Error: I keep seeing this and I have no idea why.',
      'It happens on every save, but only at home.',
      'Do you know what could be doing it?',
    ].join('\n');
    expect(classifyPaste(asking).kind).toBe('text');
  });

  it('goes out in a fence with no language on it', () => {
    expect(fenceFor(classifyPaste(NODE_TRACE))).toBe('');
  });
});

describe('classifyPaste: diffs', () => {
  it('counts the files in a git diff', () => {
    const found = classifyPaste(GIT_DIFF);
    expect(found.kind).toBe('diff');
    expect(found.label).toBe('diff, 3 files');
    expect(found.lang).toBe('diff');
  });

  it('takes a unified diff with no git header at all', () => {
    const found = classifyPaste(UNIFIED_DIFF);
    expect(found.kind).toBe('diff');
    expect(found.label).toBe('diff, 1 file');
  });

  it('takes a bare hunk, where most lines under an @@ carry a mark', () => {
    const hunk = ['@@ -1,6 +1,6 @@', ' one', ' two', '-three', '+THREE', ' four', ' five'].join('\n');
    const found = classifyPaste(hunk);
    expect(found.kind).toBe('diff');
    expect(found.label).toBe('diff');
  });

  it('beats the other readings: a diff of a log is still a diff', () => {
    const diffOfLog = [
      'diff --git a/run.log b/run.log',
      '--- a/run.log',
      '+++ b/run.log',
      '@@ -1,3 +1,3 @@',
      '-2026-09-15T08:12:01.221Z INFO  started',
      '+2026-09-15T08:12:01.221Z INFO  started again',
      ' 2026-09-15T08:12:03.981Z DEBUG cache warm',
    ].join('\n');
    expect(classifyPaste(diffOfLog).kind).toBe('diff');
  });

  it('is not a markdown rule and a bullet list', () => {
    expect(classifyPaste(MARKDOWN).kind).toBe('text');
  });
});

describe('classifyPaste: JSON', () => {
  it('takes what parses', () => {
    const found = classifyPaste(JSON_PASTE);
    expect(found.kind).toBe('json');
    expect(found.label).toBe('JSON');
    expect(found.lang).toBe('json');
  });

  it('takes an array as readily as an object', () => {
    expect(classifyPaste('[\n  {"id": 1},\n  {"id": 2},\n  {"id": 3}\n]').kind).toBe('json');
  });

  it('takes the half of a payload that reached the clipboard', () => {
    expect(() => JSON.parse(JSON_CUT) as unknown).toThrow();
    expect(classifyPaste(JSON_CUT).kind).toBe('json');
  });

  it('leaves a JavaScript object literal to the language guess', () => {
    const literal = [
      'const options = {',
      '  retries: 3,',
      '  onError: (err) => console.log(err),',
      '  timeout: 500,',
      '};',
    ].join('\n');
    const found = classifyPaste(literal);
    expect(found.kind).toBe('code');
    expect(found.lang).toBe('js');
  });

  it('goes out in a json fence', () => {
    expect(fenceFor(classifyPaste(JSON_PASTE))).toBe('json');
  });
});

describe('classifyPaste: logs', () => {
  it('reads timestamps at the start of most lines, and says how many there are', () => {
    const found = classifyPaste(ISO_LOG);
    expect(found.kind).toBe('log');
    expect(found.label).toBe('log, 5 lines');
  });

  it('reads the level every logger puts in brackets', () => {
    expect(classifyPaste(BRACKET_LOG).kind).toBe('log');
  });

  it('reads syslog, which writes the month rather than the year', () => {
    const syslog = [
      'Sep 15 08:12:01 host sshd[1]: Accepted publickey for seth',
      'Sep 15 08:12:02 host sshd[1]: session opened',
      'Sep 15 08:12:40 host sshd[1]: session closed',
      'Sep 15 08:13:00 host cron[9]: running job',
    ].join('\n');
    expect(classifyPaste(syslog).kind).toBe('log');
  });

  it('wants most of the lines, not one of them', () => {
    const mostlyProse = [
      '2026-09-15T08:12:01.221Z INFO  started',
      'this is the only line that looked like a log,',
      'and the rest of it is me explaining what I did',
      'before it happened, which is not a log at all.',
    ].join('\n');
    expect(classifyPaste(mostlyProse).kind).toBe('text');
  });

  it('goes out in a fence with no language on it', () => {
    expect(fenceFor(classifyPaste(ISO_LOG))).toBe('');
  });
});

describe('classifyPaste: code', () => {
  it('names TypeScript by its types', () => {
    const found = classifyPaste(TS_CODE);
    expect(found.kind).toBe('code');
    expect(found.label).toBe('TypeScript');
    expect(found.lang).toBe('ts');
  });

  it('names Python by its defs and its indentation', () => {
    const found = classifyPaste(PYTHON_CODE);
    expect(found.kind).toBe('code');
    expect(found.label).toBe('Python');
    expect(found.lang).toBe('py');
  });

  it('names Go, Shell and the rest of the small table', () => {
    expect(classifyPaste(GO_CODE).label).toBe('Go');
    expect(classifyPaste(SHELL_CODE).label).toBe('Shell');
    expect(classifyPaste('SELECT id, name\nFROM orders\nWHERE status = 1\nORDER BY created_at;').label).toBe('SQL');
    expect(classifyPaste('<!DOCTYPE html>\n<html>\n  <body>\n    <div>hi</div>\n  </body>\n</html>').label).toBe(
      'HTML',
    );
  });

  it('carries the language on the fence', () => {
    expect(fenceFor(classifyPaste(TS_CODE))).toBe('ts');
    expect(fenceFor(classifyPaste(PYTHON_CODE))).toBe('py');
  });

  it('a language nobody can name is text, because "code" says nothing', () => {
    const nameless = ['BEGIN', '  PUT 4 IN X', '  PUT 5 IN Y', '  SHOW X TIMES Y', 'END'].join('\n');
    expect(classifyPaste(nameless).kind).toBe('text');
  });
});

describe('classifyPaste: a URL, and everything else', () => {
  it('one line that is a URL is a URL, and keeps it as the source', () => {
    const found = classifyPaste('https://example.com/docs/paste?tab=1#chips');
    expect(found.kind).toBe('url');
    expect(found.label).toBe('URL');
    expect(found.source).toBe('https://example.com/docs/paste?tab=1#chips');
  });

  it('a URL in a sentence is a sentence', () => {
    expect(classifyPaste('have a look at https://example.com/docs before you start').kind).toBe('text');
  });

  it('a URL is not fenced, because a link in a message is a link', () => {
    expect(fenceFor(classifyPaste('https://example.com'))).toBeNull();
  });

  it('prose is text, and text is the label', () => {
    const found = classifyPaste(PROSE);
    expect(found.kind).toBe('text');
    expect(found.label).toBe('text');
    expect(found.lang).toBeUndefined();
    expect(fenceFor(found)).toBeNull();
  });
});

describe('classifyPaste: what it reads, and what that costs', () => {
  const frame = (i: number): string => `    at fn${String(i)} (/app/file${String(i)}.ts:${String(i + 1)}:1)`;
  const sentence = 'just some ordinary words in an ordinary sentence';

  it('reads the head and the tail, so a trace with prose in the middle is a trace', () => {
    const head = Array.from({ length: SAMPLE_HEAD }, (_, i) => frame(i));
    const tail = Array.from({ length: SAMPLE_TAIL }, (_, i) => frame(i + SAMPLE_HEAD));
    const middle = Array.from({ length: 400 }, () => sentence);
    expect(classifyPaste([...head, ...middle, ...tail].join('\n')).kind).toBe('stack-trace');
  });

  it('reads neither more nor less: evidence hidden in the middle is not seen', () => {
    const before = Array.from({ length: SAMPLE_HEAD + 20 }, () => sentence);
    const hidden = Array.from({ length: 10 }, (_, i) => frame(i));
    const after = Array.from({ length: SAMPLE_TAIL + 20 }, () => sentence);
    expect(classifyPaste([...before, ...hidden, ...after].join('\n')).kind).toBe('text');
  });

  it('counts every line even though it reads a few hundred', () => {
    const lines = 10_000;
    const log = Array.from(
      { length: lines },
      (_, i) => `2026-09-15T08:12:0${String(i % 10)}.000Z INFO  line ${String(i)}`,
    ).join('\n');

    const started = performance.now();
    const found = classifyPaste(log);
    const spent = performance.now() - started;

    expect(found.label).toBe('log, 10000 lines');
    // Generous by two orders of magnitude: the point is that nothing here is
    // quadratic in the size of a paste, not what this machine's clock says.
    expect(spent).toBeLessThan(250);
  });

  it('is unbothered by a megabyte on one line', () => {
    expect(classifyPaste('x'.repeat(1_000_000)).kind).toBe('text');
  });
});

describe('classifyPaste: never throws', () => {
  const trouble: readonly { readonly name: string; readonly text: string }[] = [
    { name: 'nothing at all', text: '' },
    { name: 'only spaces', text: '   \n \t \n  ' },
    { name: 'only newlines', text: '\n\n\n\n' },
    { name: 'a lone opening brace', text: '{' },
    { name: 'a payload that stops mid-key', text: '{"a":' },
    { name: 'a lone bracket', text: '[' },
    { name: 'an unpaired surrogate', text: '\uD800' },
    { name: 'a null byte', text: 'a\u0000b\u0000c' },
    { name: 'escape sequences', text: '\u001B[31mred\u001B[0m\n\u001B[32mgreen\u001B[0m' },
    { name: 'right to left', text: 'مرحبا بالعالم\nكيف حالك\nأنا بخير' },
    { name: 'emoji with modifiers', text: 'ok 👍🏽\ndone 🎉\nshipped 🚀\nagain 🌟' },
    { name: 'carriage returns', text: 'a\r\nb\r\nc\r\n' },
    { name: 'a fence and nothing else', text: '```\n```' },
    { name: 'backslashes', text: 'C:\\Users\\seth\\a\\b\\c' },
    { name: 'a hundred thousand characters on one line', text: 'a'.repeat(100_000) },
    { name: 'a regular expression that eats itself', text: `${'('.repeat(500)}x` },
    { name: 'tabs only', text: '\t\t\n\t\n\t\t\t' },
    { name: 'a lone at', text: 'at' },
    { name: 'a lone @@', text: '@@' },
    { name: 'a quote that never closes', text: '{ "a": "' },
  ];

  it.each(trouble)('answers $name without throwing', ({ text }) => {
    const found = classifyPaste(text);
    expect(found.label.length).toBeGreaterThan(0);
    expect(found.label).not.toContain('\n');
    expect(['stack-trace', 'diff', 'json', 'log', 'code', 'url', 'text']).toContain(found.kind);
  });
});

describe('pasteMarker', () => {
  it('is the number, the count and the label', () => {
    expect(pasteMarker(1, 412, 'Node stack trace from app.tsx:1442')).toBe(
      '[Pasted #1 · 412 lines · Node stack trace from app.tsx:1442]',
    );
  });

  it('says line once', () => {
    expect(pasteMarker(2, 1, 'text')).toBe('[Pasted #2 · 1 line · text]');
  });

  it('stays inside its width, cutting the label rather than the count', () => {
    const marker = pasteMarker(1, 412, 'Node stack trace from a/very/long/path/to/somewhere.tsx:144200');
    expect(marker.length).toBeLessThanOrEqual(MARKER_CHARS);
    expect(marker.startsWith('[Pasted #1 · 412 lines · Node stack trace')).toBe(true);
    expect(marker.endsWith('…]')).toBe(true);
  });

  it('drops a label that only repeats the count it sits beside', () => {
    expect(pasteMarker(1, 84, 'log, 84 lines')).toBe('[Pasted #1 · 84 lines · log]');
  });

  it('leaves the label off when there is none', () => {
    expect(pasteMarker(3, 9, '  ')).toBe('[Pasted #3 · 9 lines]');
  });

  it('puts what was classified into the marker', () => {
    expect(pasteMarker(1, 5, classifyPaste(NODE_TRACE).label)).toContain('Node stack trace from app.tsx:1442');
    expect(pasteMarker(1, 3, classifyPaste(GIT_DIFF).label)).toContain('diff, 3 files');
  });
});

describe('the fence', () => {
  const CHIP = '[Pasted #1 · 5 lines · Node stack trace from app.tsx:1442]';
  const trace = classifyPaste(NODE_TRACE);
  const prose = classifyPaste(PROSE);

  it('wraps a trace in a fence with nothing on it', () => {
    expect(expandChip(CHIP, CHIP, NODE_TRACE, trace)).toBe(`\`\`\`\n${NODE_TRACE}\n\`\`\``);
  });

  it('puts the language on the fence where the kind has one', () => {
    expect(expandChip(CHIP, CHIP, TS_CODE, classifyPaste(TS_CODE))).toBe(`\`\`\`ts\n${TS_CODE}\n\`\`\``);
    expect(expandChip(CHIP, CHIP, GIT_DIFF, classifyPaste(GIT_DIFF))).toBe(`\`\`\`diff\n${GIT_DIFF}\n\`\`\``);
    expect(expandChip(CHIP, CHIP, JSON_PASTE, classifyPaste(JSON_PASTE))).toBe(`\`\`\`json\n${JSON_PASTE}\n\`\`\``);
  });

  it('leaves prose and a link exactly as they were', () => {
    expect(expandChip(`see ${CHIP} — well?`, CHIP, PROSE, prose)).toBe(`see ${PROSE} — well?`);
    const url = classifyPaste('https://example.com');
    expect(expandChip(CHIP, CHIP, 'https://example.com', url)).toBe('https://example.com');
  });

  it('gives the block its own lines when the chip sat in a sentence', () => {
    expect(expandChip(`what is this? ${CHIP} thanks`, CHIP, NODE_TRACE, trace)).toBe(
      `what is this? \n\`\`\`\n${NODE_TRACE}\n\`\`\`\n thanks`,
    );
  });

  it('does not wrap what is already wrapped', () => {
    expect(expandChip(`\`\`\`\n${CHIP}\n\`\`\``, CHIP, NODE_TRACE, trace)).toBe(`\`\`\`\n${NODE_TRACE}\n\`\`\``);
  });

  it('decides each chip where it stands, not once for the message', () => {
    const text = `\`\`\`\n${CHIP}\n\`\`\`\nand again: ${CHIP}`;
    expect(expandChip(text, CHIP, NODE_TRACE, trace)).toBe(
      `\`\`\`\n${NODE_TRACE}\n\`\`\`\nand again: \n\`\`\`\n${NODE_TRACE}\n\`\`\``,
    );
  });

  it('opens a longer fence around a paste that has fences of its own', () => {
    const body = ['Here is a block:', '```ts', 'const a = 1;', '```', 'and that is all.'].join('\n');
    const wrapped = expandChip(CHIP, CHIP, body, { kind: 'code', label: 'Markdown', lang: 'md' });
    expect(wrapped).toBe(`\`\`\`\`md\n${body}\n\`\`\`\``);
  });

  it('counts an unclosed fence as open and a closed one as shut', () => {
    expect(insideFence('```ts\nconst a = 1;\n')).toBe(true);
    expect(insideFence('```ts\nconst a = 1;\n```\n')).toBe(false);
    expect(insideFence('no fence here at all')).toBe(false);
    expect(insideFence('~~~\nsome text\n')).toBe(true);
  });

  it('fences with three backticks, or one more than the longest run inside', () => {
    expect(fenced('plain', 'ts')).toBe('```ts\nplain\n```');
    expect(fenced('a ``` b', '')).toBe('````\na ``` b\n````');
  });
});
