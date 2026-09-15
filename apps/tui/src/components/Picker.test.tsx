import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

import { filterItems, Picker, pickerWindow, type PickerItem } from './Picker.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

const items: readonly PickerItem[] = [
  { key: 'a', label: 'Alpha', detail: 'first' },
  { key: 'b', label: 'Beta', disabled: true, reason: 'not signed in' },
  { key: 'c', label: 'Gamma', danger: true },
];

describe('Picker', () => {
  it('lists every row, including disabled ones with their reason', async () => {
    const { lastFrame } = render(<Picker title="Pick" items={items} onSelect={() => undefined} onCancel={() => undefined} />);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Pick');
    expect(frame).toContain('❯ Alpha');
    expect(frame).toContain('Beta');
    expect(frame).toContain('not signed in');
    expect(frame).toContain('Gamma');
  });

  it('opens on the initial key, moves with arrows, and will not select a disabled row', async () => {
    const onSelect = vi.fn();
    const { lastFrame, stdin } = render(
      <Picker title="Pick" items={items} initialKey="c" onSelect={onSelect} onCancel={() => undefined} />,
    );
    await tick();
    expect(lastFrame()).toContain('❯ Gamma');
    stdin.write('[A'); // up → Beta (disabled)
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSelect).not.toHaveBeenCalled();
    stdin.write('[A'); // up → Alpha
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSelect).toHaveBeenCalledWith(items[0]);
  });

  it('Esc cancels without selecting', async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(<Picker title="Pick" items={items} onSelect={onSelect} onCancel={onCancel} />);
    await tick();
    stdin.write('');
    await tick();
    expect(onCancel).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

/*
 * The scrolling window. A long list scrolls instead of growing: the folder
 * browser can offer a directory with hundreds of entries and the conversation
 * list grows without limit; either would otherwise push the picker's own
 * title off the top of the screen.
 */
describe('pickerWindow', () => {
  it('shows everything when everything fits', () => {
    expect(pickerWindow(0, 4, 12)).toEqual({ top: 0, size: 4 });
    expect(pickerWindow(3, 4, 12)).toEqual({ top: 0, size: 4 });
  });

  it('keeps the selection roughly centred once the list outgrows the window', () => {
    expect(pickerWindow(0, 100, 10)).toEqual({ top: 0, size: 10 });
    expect(pickerWindow(50, 100, 10)).toEqual({ top: 45, size: 10 });
    // And never scrolls past the end, so the last row stays reachable.
    expect(pickerWindow(99, 100, 10)).toEqual({ top: 90, size: 10 });
  });

  it('survives an empty list', () => {
    expect(pickerWindow(0, 0, 12)).toEqual({ top: 0, size: 1 });
  });
});

/*
 * Typing at a list. The scorer first, as arithmetic — which rows a query keeps
 * and in what order is the part that has to be right before any of it is drawn
 * — and then the keys, which are the part that has to keep working for the
 * pickers that were here before filtering was.
 */

const ESC = String.fromCharCode(27);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const ENTER = '\r';
const BACKSPACE = String.fromCharCode(127);
const CTRL_R = String.fromCharCode(18);
const CTRL_A = String.fromCharCode(1);

const conversations: readonly PickerItem[] = [
  { key: 'one', label: 'Rewrite the parser', detail: 'main · claude', note: '2 days ago' },
  { key: 'two', label: 'Rail filtering', detail: 'tui/overhaul · fable', note: 'just now' },
  { key: 'three', label: 'Ship the release', detail: 'main · claude', note: 'an hour ago' },
];

describe('filterItems', () => {
  it('is the list as it came when nothing has been typed', () => {
    expect(filterItems(conversations, '').map((match) => match.item.key)).toEqual(['one', 'two', 'three']);
    expect(filterItems(conversations, '   ').map((match) => match.indices)).toEqual([[], [], []]);
  });

  it('keeps the rows the characters occur in, in order, and drops the rest', () => {
    expect(filterItems(conversations, 'rail').map((match) => match.item.key)).toEqual(['two']);
    expect(filterItems(conversations, 'zzz')).toEqual([]);
  });

  it('puts an unbroken run of the query above a scattered one', () => {
    const scattered: readonly PickerItem[] = [
      { key: 'scattered', label: 'A pipeline' },
      { key: 'run', label: 'Rest api server' },
    ];

    expect(filterItems(scattered, 'api').map((match) => match.item.key)).toEqual(['run', 'scattered']);
  });

  it('matches the detail and the note as well as the label, and the label counts for more', () => {
    const fields: readonly PickerItem[] = [
      { key: 'in-detail', label: 'Something else', detail: 'tui/overhaul' },
      { key: 'in-note', label: 'Another thing', note: 'overhaul, twice' },
      { key: 'in-label', label: 'Overhaul the rail' },
    ];

    expect(filterItems(fields, 'overhaul').map((match) => match.item.key)).toEqual(['in-label', 'in-detail', 'in-note']);
  });

  it('marks where the query landed in the label, and marks nothing when it landed elsewhere', () => {
    const [labelMatch] = filterItems([{ key: 'a', label: 'Rail filtering' }], 'rail');
    expect(labelMatch?.indices).toEqual([0, 1, 2, 3]);

    const [detailMatch] = filterItems([{ key: 'b', label: 'Rail filtering', detail: 'tui/overhaul' }], 'overhaul');
    expect(detailMatch?.indices).toEqual([]);
  });

  it('keeps the caller’s order between rows it cannot separate', () => {
    const alike: readonly PickerItem[] = [
      { key: 'first', label: 'api one' },
      { key: 'second', label: 'api two' },
    ];

    expect(filterItems(alike, 'api').map((match) => match.item.key)).toEqual(['first', 'second']);
  });
});

describe('Picker, filterable', () => {
  it('narrows to what was typed, shows the query, and widens again on Backspace', async () => {
    const { lastFrame, stdin } = render(
      <Picker title="Conversations" items={conversations} filterable onSelect={() => undefined} onCancel={() => undefined} />,
    );
    await tick();
    stdin.write('rail');
    await tick();
    expect(lastFrame()).toContain('/ rail');
    // The label is cut into bold and unbold pieces and must still read as one.
    expect(lastFrame()).toContain('Rail filtering');
    expect(lastFrame()).not.toContain('Rewrite the parser');

    stdin.write(BACKSPACE);
    await tick();
    stdin.write(BACKSPACE);
    await tick();
    expect(lastFrame()).toContain('/ ra');
    expect(lastFrame()).toContain('Rewrite the parser');
  });

  it('says so when the query keeps nothing', async () => {
    const { lastFrame, stdin } = render(
      <Picker title="Conversations" items={conversations} filterable onSelect={() => undefined} onCancel={() => undefined} />,
    );
    await tick();
    stdin.write('zzz');
    await tick();
    expect(lastFrame()).toContain('nothing matches');
    expect(lastFrame()).not.toContain('Rail filtering');
  });

  it('picks the highlighted match rather than the row the cursor started on', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <Picker title="Conversations" items={conversations} filterable onSelect={onSelect} onCancel={() => undefined} />,
    );
    await tick();
    stdin.write('rail');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledWith(conversations[1]);
  });

  it('walks with the arrows only, because the letters are being typed', async () => {
    const onSelect = vi.fn();
    const { lastFrame, stdin } = render(
      <Picker title="Conversations" items={conversations} filterable onSelect={onSelect} onCancel={() => undefined} />,
    );
    await tick();
    stdin.write('j');
    await tick();
    // `j` is a character, not a step: it filtered instead of moving.
    expect(lastFrame()).toContain('/ j');

    stdin.write(BACKSPACE);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledWith(conversations[1]);

    stdin.write(UP);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenLastCalledWith(conversations[0]);
  });

  it('clears the query on the first Esc and leaves on the second', async () => {
    const onCancel = vi.fn();
    const { lastFrame, stdin } = render(
      <Picker title="Conversations" items={conversations} filterable onSelect={() => undefined} onCancel={onCancel} />,
    );
    await tick();
    stdin.write('rail');
    await tick();
    stdin.write(ESC);
    await tick();
    expect(onCancel).not.toHaveBeenCalled();
    expect(lastFrame()).not.toContain('/ rail');
    expect(lastFrame()).toContain('Rewrite the parser');

    stdin.write(ESC);
    await tick();
    expect(onCancel).toHaveBeenCalled();
  });

  it('previews on Space and renames on Ctrl+R, over the row under the cursor', async () => {
    const onPreview = vi.fn();
    const onRename = vi.fn();
    const { stdin } = render(
      <Picker
        title="Conversations"
        items={conversations}
        filterable
        onPreview={onPreview}
        onRename={onRename}
        onSelect={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await tick();
    stdin.write(' ');
    await tick();
    expect(onPreview).toHaveBeenCalledWith(conversations[0]);

    stdin.write(DOWN);
    await tick();
    stdin.write(CTRL_R);
    await tick();
    expect(onRename).toHaveBeenCalledWith(conversations[1]);
  });

  it('runs a caller’s own chord, and types a caller’s own letter', async () => {
    const archive = vi.fn();
    const pin = vi.fn();
    const { lastFrame, stdin } = render(
      <Picker
        title="Conversations"
        items={conversations}
        filterable
        onSecondary={[
          { key: 'ctrl+a', label: 'archive', run: archive },
          { key: 'p', label: 'pin', run: pin },
        ]}
        onSelect={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await tick();
    stdin.write(CTRL_A);
    await tick();
    expect(archive).toHaveBeenCalledWith(conversations[0]);

    stdin.write('p');
    await tick();
    // A bare letter is a character while the list is being typed at.
    expect(pin).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('/ p');
  });

  it('names the keys it offers, and only those', async () => {
    const full = render(
      <Picker
        title="Conversations"
        items={conversations}
        filterable
        onPreview={() => undefined}
        onRename={() => undefined}
        onSelect={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await tick();
    expect(full.lastFrame()).toContain('type to filter · ↑↓ · Enter · Space preview · Ctrl+R rename · Esc');

    const bare = render(
      <Picker title="Conversations" items={conversations} filterable onSelect={() => undefined} onCancel={() => undefined} />,
    );
    await tick();
    expect(bare.lastFrame()).toContain('type to filter · ↑↓ · Enter · Esc');
    expect(bare.lastFrame()).not.toContain('preview');

    const withKeys = render(
      <Picker
        title="Conversations"
        items={conversations}
        filterable
        onSecondary={[{ key: 'ctrl+a', label: 'archive', run: () => undefined }]}
        onSelect={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await tick();
    expect(withKeys.lastFrame()).toContain('Ctrl+A archive');
  });
});

/*
 * The pickers that were here first. Five permission modes are walked, never
 * typed at, and the permission card's list leans on `j`/`k` and on a letter
 * meaning nothing at all.
 */
describe('Picker, not filterable', () => {
  it('still walks with j and k', async () => {
    const onSelect = vi.fn();
    const { lastFrame, stdin } = render(
      <Picker title="Pick" items={items} onSelect={onSelect} onCancel={() => undefined} />,
    );
    await tick();
    stdin.write('j');
    await tick();
    expect(lastFrame()).toContain('❯ Beta');
    stdin.write('j');
    await tick();
    expect(lastFrame()).toContain('❯ Gamma');
    stdin.write('k');
    await tick();
    stdin.write('k');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledWith(items[0]);
  });

  it('types nothing and filters nothing', async () => {
    const { lastFrame, stdin } = render(
      <Picker title="Pick" items={items} onSelect={() => undefined} onCancel={() => undefined} />,
    );
    await tick();
    stdin.write('zzz');
    await tick();
    expect(lastFrame()).not.toContain('/ zzz');
    expect(lastFrame()).not.toContain('nothing matches');
    expect(lastFrame()).toContain('Alpha');
    expect(lastFrame()).toContain('↑↓ move · Enter choose · Esc back');
  });

  it('runs a caller’s bare key, which nothing else is competing for', async () => {
    const pin = vi.fn();
    const { stdin } = render(
      <Picker
        title="Pick"
        items={items}
        onSecondary={[{ key: 'p', label: 'pin', run: pin }]}
        onSelect={() => undefined}
        onCancel={() => undefined}
      />,
    );
    await tick();
    stdin.write('p');
    await tick();
    expect(pin).toHaveBeenCalledWith(items[0]);
  });
});
