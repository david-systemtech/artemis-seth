import { describe, expect, it } from 'vitest';

import {
  BOLD,
  BOLD_OFF,
  CYAN,
  DIM,
  FG_OFF,
  GREEN,
  ITALIC,
  ITALIC_OFF,
  RESET,
  UNDERLINE,
  UNDERLINE_OFF,
  hyperlink,
} from './ansi.js';
import { renderMarkdown, renderMarkdownLines } from './markdown.js';

describe('renderMarkdown', () => {
  it('renders emphasis and code spans, and leaves plain text alone', () => {
    expect(renderMarkdown('plain')).toBe('plain');
    expect(renderMarkdown('a **b** c')).toBe(`a ${BOLD}b${BOLD_OFF} c`);
    expect(renderMarkdown('a *b* c')).toBe(`a ${ITALIC}b${ITALIC_OFF} c`);
    expect(renderMarkdown('run `ls -la` now')).toBe(`run ${CYAN}ls -la${FG_OFF} now`);
  });

  it('does not look for emphasis inside code spans, and 2*3*4 is arithmetic', () => {
    expect(renderMarkdown('`**not bold**`')).toBe(`${CYAN}**not bold**${FG_OFF}`);
    expect(renderMarkdown('2*3*4')).toBe('2*3*4');
    expect(renderMarkdown('snake_case_name')).toBe('snake_case_name');
  });

  it('sets fenced code off with a gutter and never applies markdown inside it', () => {
    const out = renderMarkdown('```ts\nconst **x** = 1;\n```\nafter');
    expect(out.split('\n')).toEqual([
      `${DIM}│ ts${RESET}`,
      // Syntax-coloured by `highlight.ts`, and the `**` is still a literal.
      `${DIM}│${RESET} ${BOLD}const${BOLD_OFF} **x** = ${CYAN}1${FG_OFF};`,
      'after',
    ]);
  });

  it('survives an unclosed fence mid-stream', () => {
    expect(renderMarkdown('```\nhalf').split('\n')).toEqual([
      `${DIM}│${RESET}`,
      `${DIM}│${RESET} half`,
    ]);
  });

  it('normalises bullets and keeps ordered numbers', () => {
    expect(renderMarkdown('- one\n* two\n  - nested\n3. three')).toBe(
      [
        `${DIM}•${RESET} one`,
        `${DIM}•${RESET} two`,
        `  ${DIM}•${RESET} nested`,
        `${DIM}3.${RESET} three`,
      ].join('\n'),
    );
  });

  it('bolds headings and dims quotes and rules', () => {
    expect(renderMarkdown('## Title')).toBe(`${BOLD}Title${BOLD_OFF}`);
    expect(renderMarkdown('> said')).toBe(`${DIM}▎ said${RESET}`);
    expect(renderMarkdown('---')).toBe(`${DIM}${'─'.repeat(24)}${RESET}`);
  });

  it('leaves an unmatched marker alone', () => {
    expect(renderMarkdown('a **b')).toBe('a **b');
  });

  it('keeps what hangs in the margin apart from the text, with its width', () => {
    expect(renderMarkdownLines('- one\n  2. two\n> q\nplain')).toEqual([
      { prefix: `${DIM}•${RESET} `, hang: 2, body: 'one' },
      { prefix: `  ${DIM}2.${RESET} `, hang: 5, body: 'two' },
      { prefix: `${DIM}▎ `, hang: 2, body: `q${RESET}` },
      { prefix: '', hang: 0, body: 'plain' },
    ]);
  });
});

describe('renderMarkdown tables', () => {
  const table = '| Name | Size |\n| --- | ---: |\n| a | 1 |\n| bbb | 22 |';

  it('draws a table once its separator has arrived', () => {
    expect(renderMarkdown(table).split('\n')).toEqual([
      `${BOLD}Name${BOLD_OFF} ${DIM}\u2502${RESET} ${BOLD}Size${BOLD_OFF}`,
      `${DIM}${'\u2500'.repeat(4)}\u2500\u253c\u2500${'\u2500'.repeat(4)}${RESET}`,
      `a    ${DIM}\u2502${RESET}    1`,
      `bbb  ${DIM}\u2502${RESET}   22`,
    ]);
  });

  it('leaves a table that is still arriving as its source lines', () => {
    // The header alone, and the header with a body but no separator yet.
    expect(renderMarkdown('| Name | Size |')).toBe('| Name | Size |');
    expect(renderMarkdown('| Name | Size |\n| a | 1 |').split('\n')).toEqual([
      '| Name | Size |',
      '| a | 1 |',
    ]);
  });

  it('draws a table with a separator and no body yet', () => {
    expect(renderMarkdown('| a | b |\n| --- | --- |').split('\n')).toEqual([
      `${BOLD}a${BOLD_OFF} ${DIM}\u2502${RESET} ${BOLD}b${BOLD_OFF}`,
      `${DIM}\u2500\u2500\u253c\u2500\u2500${RESET}`,
    ]);
  });

  it('cuts a cell that would make its column too wide', () => {
    const wide = `| ${'x'.repeat(10)} |\n| --- |`;
    expect(renderMarkdown(wide, { maxColumnWidth: 6 }).split('\n')).toEqual([
      `${BOLD}xxxxx\u2026${BOLD_OFF}`,
      `${DIM}${'\u2500'.repeat(6)}${RESET}`,
    ]);
  });

  it('honours the alignment markers', () => {
    const aligned = '| left | mid | right |\n|:--- |:---:| ---:|\n| a | b | c |';
    expect(renderMarkdown(aligned).split('\n')).toEqual([
      `${BOLD}left${BOLD_OFF} ${DIM}\u2502${RESET} ${BOLD}mid${BOLD_OFF} ${DIM}\u2502${RESET} ${BOLD}right${BOLD_OFF}`,
      `${DIM}${'\u2500'.repeat(4)}\u2500\u253c\u2500${'\u2500'.repeat(3)}\u2500\u253c\u2500${'\u2500'.repeat(5)}${RESET}`,
      `a    ${DIM}\u2502${RESET}  b  ${DIM}\u2502${RESET}     c`,
    ]);
  });

  it('still reads the inline markup inside a cell', () => {
    expect(renderMarkdown('| **a** |\n| --- |\n| `b` |').split('\n')).toEqual([
      `${BOLD}${BOLD}a${BOLD_OFF}${BOLD_OFF}`,
      `${DIM}\u2500${RESET}`,
      `${CYAN}b${FG_OFF}`,
    ]);
  });

  it('closes a hyperlink it had to cut in half', () => {
    const url = 'https://x.co';
    const cut = renderMarkdown(`| [${'a'.repeat(10)}](${url}) |\n| --- |`, {
      hyperlinks: true,
      maxColumnWidth: 6,
    });
    expect(cut.split('\n')).toEqual([
      `${BOLD}${hyperlink(`${UNDERLINE}aaaaa`, url)}${RESET}\u2026${BOLD_OFF}`,
      `${DIM}${'\u2500'.repeat(6)}${RESET}`,
    ]);
  });

  it('keeps a cell the header forgot to make room for', () => {
    expect(renderMarkdown('| a |\n| --- |\n| b | c |').split('\n')).toEqual([
      // The header's missing cell is drawn as an empty one, not left bold.
      `${BOLD}a${BOLD_OFF} ${DIM}\u2502${RESET}`,
      `${DIM}\u2500\u2500\u253c\u2500\u2500${RESET}`,
      `b ${DIM}\u2502${RESET} c`,
    ]);
  });
});

describe('renderMarkdown hyperlinks', () => {
  const CAPABLE = { TERM_PROGRAM: 'iTerm.app' };
  const PLAIN = { TERM: 'xterm-256color' };
  const clickable = (text: string, url: string): string =>
    hyperlink(`${UNDERLINE}${text}${UNDERLINE_OFF}`, url);

  it('makes a link clickable in a terminal that can do it, with no address beside it', () => {
    expect(renderMarkdown('see [docs](https://x.co) now', { env: CAPABLE })).toBe(
      `see ${clickable('docs', 'https://x.co')} now`,
    );
  });

  it('prints the address beside the text where it cannot', () => {
    expect(renderMarkdown('see [docs](https://x.co) now', { env: PLAIN })).toBe(
      `see ${UNDERLINE}docs${UNDERLINE_OFF} ${DIM}https://x.co${RESET} now`,
    );
  });

  it('links a bare URL to itself and keeps the sentence punctuation out of it', () => {
    expect(renderMarkdown('at https://x.co/a.', { env: CAPABLE })).toBe(
      `at ${clickable('https://x.co/a', 'https://x.co/a')}.`,
    );
    expect(renderMarkdown('at https://x.co/a.', { env: PLAIN })).toBe('at https://x.co/a.');
  });

  it('links an absolute path and leaves a relative one as text', () => {
    expect(renderMarkdown('see /a/b/c.ts:12 now', { env: CAPABLE })).toBe(
      `see ${clickable('/a/b/c.ts:12', 'file:///a/b/c.ts')} now`,
    );
    expect(renderMarkdown('see src/render/x.ts:12 now', { env: CAPABLE })).toBe(
      'see src/render/x.ts:12 now',
    );
  });

  it('never lets an address be read as emphasis', () => {
    expect(renderMarkdown('https://x.co/a_b_c', { env: PLAIN })).toBe('https://x.co/a_b_c');
  });

  it('recognises the terminals that draw OSC 8, and no others', () => {
    const on = (env: Record<string, string>): boolean =>
      renderMarkdown('[a](u)', { env }) === clickable('a', 'u');

    expect(on({ TERM_PROGRAM: 'iTerm.app' })).toBe(true);
    expect(on({ TERM_PROGRAM: 'WezTerm' })).toBe(true);
    expect(on({ TERM: 'xterm-kitty' })).toBe(true);
    expect(on({ TERM: 'xterm-ghostty' })).toBe(true);
    expect(on({ TERM: 'alacritty' })).toBe(true);
    expect(on({ TERM: 'foot-extra' })).toBe(true);
    expect(on({ WT_SESSION: 'x' })).toBe(true);
    expect(on({ VTE_VERSION: '5002' })).toBe(true);

    expect(on({ VTE_VERSION: '4900' })).toBe(false);
    expect(on({ TERM: 'xterm-256color' })).toBe(false);
    expect(on({ TERM: 'screen' })).toBe(false);
    expect(on({ TERM: 'dumb', TERM_PROGRAM: 'iTerm.app' })).toBe(false);
    expect(on({})).toBe(false);
  });

  it('is overridden either way by the option', () => {
    expect(renderMarkdown('[a](u)', { env: PLAIN, hyperlinks: true })).toBe(clickable('a', 'u'));
    expect(renderMarkdown('[a](u)', { env: CAPABLE, hyperlinks: false })).toBe(
      `${UNDERLINE}a${UNDERLINE_OFF} ${DIM}u${RESET}`,
    );
  });
});

describe('renderMarkdown code blocks', () => {
  it('colours a fenced block in its own language, across lines', () => {
    expect(renderMarkdown('```py\ndef f():\n    return "x"\n```').split('\n')).toEqual([
      `${DIM}\u2502 py${RESET}`,
      `${DIM}\u2502${RESET} ${BOLD}def${BOLD_OFF} f():`,
      `${DIM}\u2502${RESET}     ${BOLD}return${BOLD_OFF} ${GREEN}"x"${FG_OFF}`,
    ]);
  });

  it('leaves a markdown fence inside a fence alone', () => {
    expect(renderMarkdown('```markdown\n**bold** and `code`\n```').split('\n')).toEqual([
      `${DIM}\u2502 markdown${RESET}`,
      `${DIM}\u2502${RESET} **bold** and \`code\``,
    ]);
  });

  it('starts each block fresh, so an unclosed comment does not colour the prose after it', () => {
    const out = renderMarkdown('```ts\n/* open\n```\nafter\n```ts\nconst x = 1;\n```');
    expect(out.split('\n')).toEqual([
      `${DIM}\u2502 ts${RESET}`,
      `${DIM}\u2502${RESET} ${DIM}${ITALIC}/* open${ITALIC_OFF}${BOLD_OFF}`,
      'after',
      `${DIM}\u2502 ts${RESET}`,
      `${DIM}\u2502${RESET} ${BOLD}const${BOLD_OFF} x = ${CYAN}1${FG_OFF};`,
    ]);
  });
});
