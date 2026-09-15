/*
 * The one-line box.
 *
 * What is worth checking is the contract the callers lean on: Enter hands back
 * what is in the line and Esc hands back nothing, the line starts on what it
 * was seeded with rather than empty, and the editing is the composer's — a
 * Ctrl+W that took a word off the wrong end would be a name saved wrong.
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

import { Prompt } from './Prompt.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

const ESC = String.fromCharCode(27);
const CTRL_U = String.fromCharCode(21);
const CTRL_W = String.fromCharCode(23);
const LEFT = `${ESC}[D`;

describe('Prompt', () => {
  it('draws the question and opens on what it was seeded with', async () => {
    const { lastFrame } = render(
      <Prompt title="Name this conversation" initial="the rail" onSubmit={() => undefined} onCancel={() => undefined} />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Name this conversation');
    expect(frame).toContain('the rail');
    expect(frame).toContain('Esc leaves it as it was');
  });

  it('shows the placeholder only while the line is empty', async () => {
    const { lastFrame, stdin } = render(
      <Prompt title="Name it" placeholder="a short name" onSubmit={() => undefined} onCancel={() => undefined} />,
    );
    await tick();
    expect(lastFrame()).toContain('a short name');
    stdin.write('x');
    await tick();
    expect(lastFrame()).not.toContain('a short name');
  });

  it('hands back the line on Enter, typed onto the end of what was there', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<Prompt title="Name it" initial="fix" onSubmit={onSubmit} onCancel={() => undefined} />);
    await tick();
    stdin.write(' the tests');
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('fix the tests');
  });

  it('hands back nothing at all on Esc', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(<Prompt title="Name it" initial="fix" onSubmit={onSubmit} onCancel={onCancel} />);
    await tick();
    stdin.write('more');
    await tick();
    stdin.write(ESC);
    await tick();
    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits an empty line rather than deciding what an empty line meant', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<Prompt title="Name it" initial="ab" onSubmit={onSubmit} onCancel={() => undefined} />);
    await tick();
    stdin.write(CTRL_U);
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('');
  });

  it('edits with the composer’s own keys', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <Prompt title="Name it" initial="fix the tests" onSubmit={onSubmit} onCancel={() => undefined} />,
    );
    await tick();
    // Ctrl+W takes the word before the cursor, as it does in the composer.
    stdin.write(CTRL_W);
    await tick();
    stdin.write('build');
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('fix the build');
  });

  it('moves along the line rather than up and down it', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<Prompt title="Name it" initial="ac" onSubmit={onSubmit} onCancel={() => undefined} />);
    await tick();
    stdin.write(LEFT);
    await tick();
    stdin.write('b');
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('abc');
  });

  it('keeps the words of a pasted paragraph and loses its line breaks', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<Prompt title="Name it" onSubmit={onSubmit} onCancel={() => undefined} />);
    await tick();
    stdin.write('one\ntwo');
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('one two');
  });

  it('answers nothing at all while it is not active', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(
      <Prompt title="Name it" initial="fix" isActive={false} onSubmit={onSubmit} onCancel={onCancel} />,
    );
    await tick();
    stdin.write('x');
    stdin.write(ESC);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
