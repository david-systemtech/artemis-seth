import { describe, expect, it } from 'vitest';

import {
  BLUE,
  BOLD,
  BOLD_OFF,
  CYAN,
  DIM,
  DIM_OFF,
  FG_OFF,
  GREEN,
  ITALIC,
  ITALIC_OFF,
  MAGENTA,
} from './ansi.js';
import { HIGHLIGHT_START, highlightLine } from './highlight.js';

/** The same six shapes the highlighter paints with, spelled out once here. */
const kw = (s: string): string => `${BOLD}${s}${BOLD_OFF}`;
const str = (s: string): string => `${GREEN}${s}${FG_OFF}`;
const num = (s: string): string => `${CYAN}${s}${FG_OFF}`;
const com = (s: string): string => `${DIM}${ITALIC}${s}${ITALIC_OFF}${DIM_OFF}`;
const vari = (s: string): string => `${MAGENTA}${s}${FG_OFF}`;
const flag = (s: string): string => `${BLUE}${s}${FG_OFF}`;

/** A whole block, each line starting where the line above left off. */
function block(source: string, lang: string): readonly string[] {
  let state = HIGHLIGHT_START;
  const out: string[] = [];
  for (const line of source.split('\n')) {
    const painted = highlightLine(line, lang, state);
    state = painted.state;
    out.push(painted.text);
  }
  return out;
}

const paint = (line: string, lang: string): string => highlightLine(line, lang, HIGHLIGHT_START).text;

describe('highlightLine', () => {
  it('paints the C family: keywords bold, numbers cyan, strings green, comments dim', () => {
    expect(paint('const x = 1; // note', 'ts')).toBe(
      `${kw('const')} x = ${num('1')}; ${com('// note')}`,
    );
    expect(paint('const s = "hi";', 'ts')).toBe(`${kw('const')} s = ${str('"hi"')};`);
    expect(paint('let n = 0xFF;', 'js')).toBe(`${kw('let')} n = ${num('0xFF')};`);
  });

  it('gives each language its own words', () => {
    expect(paint('func main() {', 'go')).toBe(`${kw('func')} main() {`);
    expect(paint('fn main() {', 'rust')).toBe(`${kw('fn')} main() {`);
    expect(paint('public void run() {', 'java')).toBe(`${kw('public')} ${kw('void')} run() {`);
    expect(paint('int n = 2;', 'c')).toBe(`${kw('int')} n = ${num('2')};`);
    expect(paint('val n = 2', 'kotlin')).toBe(`${kw('val')} n = ${num('2')}`);
    expect(paint('let n = 2', 'swift')).toBe(`${kw('let')} n = ${num('2')}`);
    expect(paint('using System;', 'cs')).toBe(`${kw('using')} System;`);
    // A word one language spells is not a word in the next.
    expect(paint('fn x', 'go')).toBe('fn x');
    expect(paint('func x', 'rust')).toBe('func x');
  });

  it('leaves a capitalised identifier in the default foreground', () => {
    expect(paint('const Foo = 1;', 'ts')).toBe(`${kw('const')} Foo = ${num('1')};`);
  });

  it('carries a block comment across lines', () => {
    expect(block('/* one\n   two */ const x', 'ts')).toEqual([
      com('/* one'),
      `${com('   two */')} ${kw('const')} x`,
    ]);
  });

  it('carries a template string across lines', () => {
    expect(block('const t = `a\nb${x}`;', 'ts')).toEqual([
      `${kw('const')} t = ${str('`a')}`,
      `${str('b${x}`')};`,
    ]);
  });

  it('carries a python docstring across lines and knows python words', () => {
    expect(block('def f():\n    """doc\n    more"""\n    return 1', 'py')).toEqual([
      `${kw('def')} f():`,
      `    ${str('"""doc')}`,
      // Once a docstring is open the whole of the next line is inside it.
      str('    more"""'),
      `    ${kw('return')} ${num('1')}`,
    ]);
  });

  it('paints shell variables, flags, strings and comments', () => {
    expect(paint('ls -la $HOME # look', 'bash')).toBe(
      `ls ${flag('-la')} ${vari('$HOME')} ${com('# look')}`,
    );
    expect(paint('echo "${NAME}"', 'sh')).toBe(`echo ${str('"${NAME}"')}`);
    expect(paint('for f in a; do', 'sh')).toBe(`${kw('for')} f ${kw('in')} a; ${kw('do')}`);
    // A `#` inside a word or a string is not a comment.
    expect(paint('echo "a#b"', 'sh')).toBe(`echo ${str('"a#b"')}`);
  });

  it('paints json and yaml', () => {
    expect(paint('{"a": 1, "b": true}', 'json')).toBe(
      `{${str('"a"')}: ${num('1')}, ${str('"b"')}: ${kw('true')}}`,
    );
    expect(paint('name: value # why', 'yaml')).toBe(`${kw('name')}: value ${com('# why')}`);
    expect(paint('  - port: 8080', 'yml')).toBe(`  - ${kw('port')}: ${num('8080')}`);
  });

  it('leaves prose languages exactly as they were written', () => {
    expect(paint('**bold** and `code`', 'markdown')).toBe('**bold** and `code`');
    expect(paint('const x = 1;', 'text')).toBe('const x = 1;');
    expect(paint('- removed', 'diff')).toBe('- removed');
    // No language at all: as likely to be output as it is to be code.
    expect(paint('const x = 1;', '')).toBe('const x = 1;');
  });

  it('gives an unknown language strings, comments and numbers only', () => {
    expect(paint('defmodule X do', 'elixir')).toBe('defmodule X do');
    expect(paint('x = "s" # why', 'elixir')).toBe(`x = ${str('"s"')} ${com('# why')}`);
    expect(paint('x = 42', 'elixir')).toBe(`x = ${num('42')}`);
    // The `//` in a URL is not the start of a comment.
    expect(paint('curl https://x.co/a', 'elixir')).toBe('curl https://x.co/a');
  });

  it('never throws on an unterminated anything, and does not leak the damage', () => {
    const open = highlightLine('const s = "oops;', 'ts', HIGHLIGHT_START);
    expect(open.text).toBe(`${kw('const')} s = ${str('"oops;')}`);
    // A single-quoted string ends with its line, so the next line starts clean.
    expect(open.state.open).toBeNull();

    const comment = highlightLine('/* forever', 'ts', HIGHLIGHT_START);
    expect(comment.state.open).toEqual({ close: '*/', token: 'comment' });
    expect(highlightLine('still', 'ts', comment.state).text).toBe(com('still'));

    const template = highlightLine('`forever', 'ts', HIGHLIGHT_START);
    expect(template.state.open).toEqual({ close: '`', token: 'string' });

    for (const odd of ['', '"', "'''", '/*', '*/', '`', '#', '${', '\\', '0x']) {
      for (const lang of ['ts', 'py', 'sh', 'json', 'yaml', 'rust', 'nope', '']) {
        expect(() => highlightLine(odd, lang, HIGHLIGHT_START)).not.toThrow();
      }
    }
  });

  it('keeps an escaped quote inside the string it belongs to', () => {
    expect(paint('const s = "a\\"b";', 'ts')).toBe(`${kw('const')} s = ${str('"a\\"b"')};`);
  });

  it('is unchanged by an empty line, and keeps what was open across it', () => {
    const open = { open: { close: '*/', token: 'comment' } } as const;
    expect(highlightLine('', 'ts', open)).toEqual({ text: '', state: open });
  });
});
