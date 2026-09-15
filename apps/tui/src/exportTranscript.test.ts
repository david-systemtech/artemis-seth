/**
 * What `/copy` and `/export` hand over.
 *
 * Every case here is built the way the app builds one: a real
 * {@link TranscriptModel} fed hand-made provider events, flushed synchronously.
 * Nothing asserts against a hand-assembled item, because the interesting part of
 * this module is how it reads a transcript the *model* shaped — the fold, the
 * order the rows come back in, which block a `text.complete` landed in.
 */

import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@rx-artemis/protocol';
import { TranscriptModel, syncScheduler } from '@rx-artemis/transcript';

import { codeBlocksOf, exportFilename, lastAssistantText, transcriptToMarkdown } from './exportTranscript.js';

/** One event of a run, minus the envelope the tests do not care about. */
type Draft = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, 'runId' | 'seq' | 'ts'> : never) : never;

/**
 * A model with these events applied. Timestamps rise with position, which is
 * what the on-screen ordering rests on.
 */
function transcript(...drafts: readonly Draft[]): TranscriptModel {
  const model = new TranscriptModel(syncScheduler);
  drafts.forEach((draft, index) => {
    model.apply({ ...draft, runId: 'run_1', seq: index, ts: 1000 + index } as AgentEvent);
  });
  model.flush();
  return model;
}

/** A turn that ran three calls, one of which failed, and wrote a file. */
function worked(): TranscriptModel {
  return transcript(
    { type: 'text.complete', role: 'user', messageId: 'u1', text: 'Run the tests and fix the failure.' },
    { type: 'thinking.delta', messageId: 'm1', blockIndex: 0, text: 'Tests first, then the fix.' },
    { type: 'text.complete', role: 'assistant', messageId: 'm1', blockIndex: 1, text: "I'll run them." },
    { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'pnpm test' } },
    { type: 'tool.end', toolCallId: 'c1', status: 'ok', resultText: '2 passed\n1 failed', durationMs: 4200 },
    {
      type: 'tool.start',
      toolCallId: 'c2',
      name: 'Edit',
      input: { file_path: '/code/artemis/src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
    },
    { type: 'tool.end', toolCallId: 'c2', status: 'ok', durationMs: 120 },
    { type: 'tool.start', toolCallId: 'c3', name: 'Bash', input: { command: 'pnpm lint' } },
    { type: 'tool.end', toolCallId: 'c3', status: 'error', error: { code: 'unknown', message: 'exit code 1' }, durationMs: 900 },
    { type: 'text.complete', role: 'assistant', messageId: 'm2', blockIndex: 0, text: 'Fixed. **Done**.' },
    {
      type: 'run.end',
      reason: 'completed',
      durationMs: 66_000,
      usage: { scope: 'final', tokens: { inputTokens: 9_200, outputTokens: 400 }, costUsd: 0.04 },
    },
  );
}

/* -------------------------------------------------------------------------- */

describe('lastAssistantText', () => {
  it('takes the newest reply as markdown source, not as it was drawn', () => {
    const model = transcript(
      { type: 'text.complete', role: 'user', messageId: 'u1', text: 'Two questions.' },
      { type: 'text.complete', role: 'assistant', messageId: 'm1', blockIndex: 0, text: 'First answer.' },
      { type: 'text.complete', role: 'assistant', messageId: 'm2', blockIndex: 0, text: 'Second, with **bold** and `code`.' },
    );
    expect(lastAssistantText(model)).toBe('Second, with **bold** and `code`.');
  });

  it('ignores a block the provider opened and never filled', () => {
    const model = transcript(
      { type: 'text.complete', role: 'assistant', messageId: 'm1', blockIndex: 0, text: 'The answer.' },
      { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'ls' } },
      // A block that exists and holds nothing: copying it would put the empty
      // string on the clipboard and report success.
      { type: 'text.delta', messageId: 'm2', blockIndex: 0, text: '' },
    );
    expect(lastAssistantText(model)).toBe('The answer.');
  });

  it('is null when the agent has not said anything yet', () => {
    const model = transcript({ type: 'text.complete', role: 'user', messageId: 'u1', text: 'Hello?' });
    expect(lastAssistantText(model)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('codeBlocksOf', () => {
  it('finds the fenced blocks of a reply, with and without a language', () => {
    const reply = ['Try this:', '', '```bash', 'pnpm test', '```', '', 'then:', '', '```', 'echo done', '```', ''].join('\n');
    expect(codeBlocksOf(reply)).toEqual([
      { lang: 'bash', code: 'pnpm test' },
      { lang: '', code: 'echo done' },
    ]);
  });

  it('keeps the first word of the info string as the language', () => {
    expect(codeBlocksOf(['```ts title=a.ts', 'const a = 1;', '```'].join('\n'))).toEqual([
      { lang: 'ts', code: 'const a = 1;' },
    ]);
  });

  it('lets a longer fence hold a shorter one, which is how a reply quotes markdown', () => {
    const reply = ['`````md', '```ts', 'const a = 1;', '```', '`````'].join('\n');
    expect(codeBlocksOf(reply)).toEqual([{ lang: 'md', code: ['```ts', 'const a = 1;', '```'].join('\n') }]);
  });

  it('runs an unclosed fence to the end, and strips the fence indent', () => {
    expect(codeBlocksOf(['  ```', '  one', '  two'].join('\n'))).toEqual([{ lang: '', code: 'one\ntwo' }]);
  });

  it('finds nothing in prose', () => {
    expect(codeBlocksOf('Just words, and some `inline code`.')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe('transcriptToMarkdown', () => {
  it('writes a titled, dated document with the turns under plain headings', () => {
    const model = transcript(
      { type: 'text.complete', role: 'user', messageId: 'u1', text: 'Why does login fail?' },
      { type: 'text.complete', role: 'assistant', messageId: 'm1', blockIndex: 0, text: 'Because the token expired.' },
      {
        type: 'run.end',
        reason: 'completed',
        durationMs: 66_000,
        usage: { scope: 'final', tokens: { inputTokens: 9_200, outputTokens: 400 }, costUsd: 0.04 },
      },
    );

    // A local wall-clock time, so the line reads the same in every timezone.
    const startedAt = new Date(2026, 2, 5, 14, 30).getTime();
    expect(transcriptToMarkdown(model, { title: 'Fix the login bug', startedAt })).toBe(
      [
        '# Fix the login bug',
        '',
        '_2026-03-05 14:30_',
        '',
        '## You',
        '',
        'Why does login fail?',
        '',
        '## Agent',
        '',
        'Because the token expired.',
        '',
        '_1m 6s · 9.2k tok · $0.040_',
        '',
      ].join('\n'),
    );
  });

  it('puts the run’s work where it began, not at the foot of the run', () => {
    const doc = transcriptToMarkdown(worked());
    const at = (text: string): number => doc.indexOf(text);

    expect(at('## You')).toBeGreaterThanOrEqual(0);
    expect(at('Run the tests and fix the failure.')).toBeLessThan(at("I'll run them."));
    // The model parks the calls under the run; on the page they belong between
    // the sentence that led to them and the sentence that came of them.
    expect(at("I'll run them.")).toBeLessThan(at('- Ran 2 commands, edited a file'));
    expect(at('- Ran 2 commands, edited a file')).toBeLessThan(at('Fixed. **Done**.'));
    expect(at('Fixed. **Done**.')).toBeLessThan(at('_1m 6s'));
    // Two replies, two headings — the work between them closed the first.
    expect(doc.match(/^## Agent$/gm)).toHaveLength(2);
  });

  it('gives a call a bullet and its output a fenced block', () => {
    const doc = transcriptToMarkdown(worked());
    expect(doc).toContain('- **Bash** `pnpm test` · 4.2s · ok');
    expect(doc).toContain(['```', '2 passed', '1 failed', '```'].join('\n'));
  });

  it('gives an edit a fenced diff', () => {
    const doc = transcriptToMarkdown(worked());
    expect(doc).toContain('- **Edit** `/code/artemis/src/a.ts` · 120ms · ok');
    expect(doc).toContain(
      ['```diff', '--- /code/artemis/src/a.ts', '+++ /code/artemis/src/a.ts', '-const a = 1;', '+const a = 2;', '```'].join('\n'),
    );
  });

  it('keeps the reading copy to the summary and the failure', () => {
    const doc = transcriptToMarkdown(worked(), { toolOutput: false });

    expect(doc).toContain('- Ran 2 commands, edited a file');
    // The one call worth reading in a burst is the one that went wrong.
    expect(doc).toContain('- **Bash** `pnpm lint` · 900ms · error — exit code 1');
    // Everything that worked is the summary line and nothing else.
    expect(doc).not.toContain('pnpm test');
    expect(doc).not.toContain('2 passed');
    expect(doc).not.toContain('```diff');
  });

  it('leaves the reasoning out unless it is asked for, and folds it when it is', () => {
    const model = worked();

    expect(transcriptToMarkdown(model)).not.toContain('Tests first, then the fix.');

    const doc = transcriptToMarkdown(model, { thinking: true });
    expect(doc).toContain(
      ['<details><summary>Thinking</summary>', '', 'Tests first, then the fix.', '', '</details>'].join('\n'),
    );
    // Before the sentence it led to, where the model put it.
    expect(doc.indexOf('<details>')).toBeLessThan(doc.indexOf("I'll run them."));
  });

  it('cuts a long result and says by how much', () => {
    const model = transcript(
      { type: 'tool.start', toolCallId: 'c1', name: 'Bash', input: { command: 'cat big.log' } },
      {
        type: 'tool.end',
        toolCallId: 'c1',
        status: 'ok',
        resultText: Array.from({ length: 250 }, (_, i) => `line ${String(i + 1)}`).join('\n'),
      },
      { type: 'run.end', reason: 'completed' },
    );
    const doc = transcriptToMarkdown(model);

    expect(doc).toContain('line 200');
    expect(doc).not.toContain('line 201');
    expect(doc).toContain('… +50 lines');
  });

  it('fences output that is itself fenced, without ending the block early', () => {
    const model = transcript(
      { type: 'tool.start', toolCallId: 'c1', name: 'Read', input: { file_path: '/code/artemis/README.md' } },
      { type: 'tool.end', toolCallId: 'c1', status: 'ok', resultText: '```js\nok\n```' },
      { type: 'run.end', reason: 'completed' },
    );
    expect(transcriptToMarkdown(model)).toContain(['````', '```js', 'ok', '```', '````'].join('\n'));
  });

  it('records the decisions, the asides and the commands', () => {
    const model = transcript(
      {
        type: 'permission.request',
        requestId: 'r1',
        request: { id: 'r1', runId: 'run_1', toolName: 'Bash', input: { command: 'rm -rf build' }, requestedAt: 1_000 },
      },
      { type: 'permission.resolved', requestId: 'r1', outcome: 'allowed' },
      { type: 'command.run', command: { name: 'model', args: 'sonnet', output: 'Model set to sonnet.' } },
      { type: 'command.run', source: 'shell', command: { name: 'git', args: 'status' } },
      { type: 'run.end', reason: 'interrupted', durationMs: 2_000 },
    );
    const doc = transcriptToMarkdown(model);

    expect(doc).toContain('- ⚿ Bash — allowed');
    expect(doc).toContain('- / model sonnet');
    // A `!` line ran in the shell; exported with a slash it reads as a command
    // the app has, and the reader goes looking for one.
    expect(doc).toContain('- $ git status');
    expect(doc).toContain(['```', 'Model set to sonnet.', '```'].join('\n'));
    expect(doc).toContain('_Interrupted · 2.0s_');
  });

  it('names the folder when the calls agree on one', () => {
    const model = transcript(
      { type: 'tool.start', toolCallId: 'c1', name: 'Read', input: { file_path: '/code/artemis/src/a.ts' } },
      { type: 'tool.end', toolCallId: 'c1', status: 'ok', resultText: 'ok' },
      { type: 'tool.start', toolCallId: 'c2', name: 'Read', input: { file_path: '/code/artemis/docs/b.md' } },
      { type: 'tool.end', toolCallId: 'c2', status: 'ok', resultText: 'ok' },
      { type: 'run.end', reason: 'completed' },
    );
    const startedAt = new Date(2026, 2, 5, 14, 30).getTime();
    expect(transcriptToMarkdown(model, { startedAt })).toContain('_2026-03-05 14:30 · /code/artemis_');
  });

  it('says nothing at all about an empty transcript', () => {
    expect(transcriptToMarkdown(new TranscriptModel(syncScheduler))).toBe('');
  });
});

/* -------------------------------------------------------------------------- */

describe('exportFilename', () => {
  const at = new Date(2026, 2, 5, 14, 30);

  it('slugs the title and stamps the local clock', () => {
    expect(exportFilename('Fix the login bug!', at)).toBe('artemis-fix-the-login-bug-2026-03-05-1430.md');
  });

  it('folds accents to ASCII and drops everything else', () => {
    expect(exportFilename('¿Café ☕ résumé?', at)).toBe('artemis-cafe-resume-2026-03-05-1430.md');
  });

  it('cuts a long title at a word, never past forty characters', () => {
    const name = exportFilename('The quick brown fox jumps over the lazy dog and keeps going', at);
    expect(name).toBe('artemis-the-quick-brown-fox-jumps-over-the-lazy-2026-03-05-1430.md');
    expect(name.slice('artemis-'.length, -'-2026-03-05-1430.md'.length).length).toBeLessThanOrEqual(40);
  });

  it('falls back to the date alone without a usable title', () => {
    expect(exportFilename(undefined, at)).toBe('artemis-2026-03-05-1430.md');
    expect(exportFilename('!!!', at)).toBe('artemis-2026-03-05-1430.md');
  });

  it('takes a timestamp as readily as a date', () => {
    expect(exportFilename('Notes', at.getTime())).toBe('artemis-notes-2026-03-05-1430.md');
  });
});
