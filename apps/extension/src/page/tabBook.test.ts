import { describe, expect, it } from 'vitest';

import { TabBook } from './tabBook.js';

describe('TabBook', () => {
  it('keeps one tab per conversation', () => {
    const book = new TabBook();
    book.remember('run-a', 11);
    book.remember('run-b', 12);
    expect(book.tabFor('run-a')).toBe(11);
    expect(book.tabFor('run-b')).toBe(12);
    book.remember('run-a', 13);
    expect(book.tabFor('run-a')).toBe(13);
    expect(book.size).toBe(2);
  });

  it('knows nothing about a conversation that has not opened a page', () => {
    expect(new TabBook().tabFor('run-a')).toBeNull();
  });

  it('owns only the tabs it was told about, which is what every event is checked against', () => {
    const book = new TabBook();
    book.remember('run-a', 11);
    expect(book.owns(11)).toBe(true);
    expect(book.owns(12)).toBe(false);
  });

  it('gives up a tab the user closed and says whose it was', () => {
    const book = new TabBook();
    book.remember('run-a', 11);
    expect(book.forgetTab(11)).toBe('run-a');
    expect(book.forgetTab(11)).toBeNull();
    expect(book.owns(11)).toBe(false);
  });

  it('gives up a conversation’s tab and hands back the id so it can be closed', () => {
    const book = new TabBook();
    book.remember('run-a', 11);
    expect(book.forgetRun('run-a')).toBe(11);
    expect(book.forgetRun('run-a')).toBeNull();
  });

  it('hands back every tab at once when Artemis is stopped, and keeps none', () => {
    const book = new TabBook();
    book.remember('run-a', 11);
    book.remember('run-b', 12);
    book.groupId = 99;
    expect([...book.clear()].sort()).toEqual([11, 12]);
    expect(book.size).toBe(0);
    expect(book.groupId).toBeNull();
  });

  it('survives a stopped service worker through storage', () => {
    const book = new TabBook();
    book.remember('run-a', 11);
    book.groupId = 99;
    const revived = TabBook.fromSnapshot(JSON.parse(JSON.stringify(book.toSnapshot())) as ReturnType<TabBook['toSnapshot']>);
    expect(revived.tabFor('run-a')).toBe(11);
    expect(revived.groupId).toBe(99);
  });

  it('drops anything in storage that is not a tab id, rather than believing it', () => {
    const revived = TabBook.fromSnapshot({ tabs: { 'run-a': 11, 'run-b': 'twelve' as unknown as number, 'run-c': 1.5 }, groupId: null });
    expect(revived.entries()).toEqual([{ runKey: 'run-a', tabId: 11 }]);
  });
});
