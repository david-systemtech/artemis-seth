/**
 * Resuming a served conversation lands on the account that holds it.
 *
 * An Artemis Server profile is one profile wearing every account the server
 * offers, and the transcript of a served conversation lives in exactly one of
 * their stores. `resumeSession` switching the *profile* is therefore only half
 * of a served resume: the model route has to name the holding account too, or
 * the resume goes out on whatever the column was left showing, the server's
 * provider looks in the wrong store, and the conversation fails to open — and
 * then, before the server learned to correct it, vanished from the list.
 *
 * The row names its account (`SessionSummary.accountSlug`), and these pin
 * what the column does with it: move onto that account's route, keep a choice
 * already there, honour the conversation's own remembered model when it is on
 * that account, and leave a row that names no account exactly as before.
 *
 * Same caveat as `sharedStoreResume.test.ts`: `renderer/tsconfig.json`
 * excludes test files, so the assertions here are behavioural.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ProviderModelOption, SessionSummary } from '@rx-artemis/protocol';

import { focusedPane, resumeSession, useApp } from './store';
import { paneState } from './pane';
import { seedApp } from './testkit';

const pane = () => focusedPane();
const session = () => paneState(pane());

function noticeText(): string {
  const transcript = pane().transcript;
  transcript.flush();
  return transcript
    .getListSnapshot()
    .map((id) => JSON.stringify(transcript.getItem(id) ?? null))
    .join('\n');
}

/** The served catalogue: two accounts, as the server flattens them. */
const MODELS: readonly ProviderModelOption[] = [
  { id: 'gmail/opus', label: 'Opus', note: 'gmail — the big one', accountSlug: 'gmail', accountLabel: 'gmail' },
  {
    id: 'andyou/opus',
    label: 'Opus',
    note: 'david@andyou.ph max — the big one',
    accountSlug: 'andyou',
    accountLabel: 'david@andyou.ph max',
  },
  {
    id: 'andyou/haiku',
    label: 'Haiku',
    note: 'david@andyou.ph max — the quick one',
    accountSlug: 'andyou',
    accountLabel: 'david@andyou.ph max',
  },
];

function served(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'srv-sess-1',
    providerId: 'artemis',
    profileId: 'srv',
    cwd: '/work/repo',
    title: 'Held over there',
    updatedAt: 10,
    accountSlug: 'andyou',
    accountId: 'e49',
    ...over,
  } as SessionSummary;
}

beforeEach(() => {
  seedApp({
    profiles: [{ id: 'srv', label: 'Artemis Server', providerId: 'artemis', configDir: '/u/.srv' }],
    activeProviderId: 'artemis',
    activeProfileId: 'srv',
    cwd: '/work/repo',
    run: null,
    resumeSessionId: null,
    permissionQueue: [],
    banners: [],
    models: [...MODELS],
    model: 'gmail/opus',
    modelBySession: {},
  });
  pane().transcript.reset();
});

describe('resuming a served conversation', () => {
  it('moves the column onto the account that holds it, and says so', () => {
    resumeSession(served());

    expect(session().resumeSessionId).toBe('srv-sess-1');
    expect(session().model).toBe('andyou/opus');
    expect(noticeText()).toContain('account → david@andyou.ph max');
    expect(noticeText()).toContain('holds it');
  });

  it('remembers the corrected choice for the conversation', () => {
    resumeSession(served());
    expect(useApp.getState().modelBySession['srv-sess-1']?.model).toBe('andyou/opus');
  });

  it('leaves a column already on that account alone', () => {
    seedApp({ model: 'andyou/opus' });
    resumeSession(served());

    expect(session().model).toBe('andyou/opus');
    expect(noticeText()).toBe('');
  });

  it('honours the conversation’s own remembered model when it is on that account', () => {
    seedApp({
      modelBySession: {
        'srv-sess-1': { model: 'andyou/haiku', effort: null, fastMode: false, ultracode: false },
      },
    });
    resumeSession(served());

    expect(session().model).toBe('andyou/haiku');
    expect(noticeText()).toBe('');
  });

  it('overrides a remembered model on the wrong account', () => {
    // Remembered from the resume that failed: the column was on gmail then too.
    seedApp({
      modelBySession: {
        'srv-sess-1': { model: 'gmail/opus', effort: null, fastMode: false, ultracode: false },
      },
    });
    resumeSession(served());

    expect(session().model).toBe('andyou/opus');
  });

  it('does nothing for a row that names no account', () => {
    resumeSession(served({ accountSlug: undefined, accountId: undefined }));

    expect(session().resumeSessionId).toBe('srv-sess-1');
    expect(session().model).toBe('gmail/opus');
    expect(noticeText()).toBe('');
  });
});
