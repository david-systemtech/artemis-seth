import { describe, expect, it } from 'vitest';

import { appendAudit, auditFromStorage, auditHost, type AuditEntry } from './audit.js';

const entry = (at: number): AuditEntry => ({ at, runKey: 'run-a', verb: 'read', host: 'localhost', outcome: 'ok' });

describe('appendAudit', () => {
  it('keeps the newest entries and drops the oldest at the ceiling', () => {
    let log: readonly AuditEntry[] = [];
    for (let i = 0; i < 5; i += 1) log = appendAudit(log, entry(i), 3);
    expect(log.map((line) => line.at)).toEqual([2, 3, 4]);
  });

  it('does not change the log it was given, so what is written is what is held', () => {
    const before: readonly AuditEntry[] = [entry(1)];
    appendAudit(before, entry(2), 10);
    expect(before).toHaveLength(1);
  });

  it('records a refusal with the sentence the agent was given', () => {
    const [line] = appendAudit([], { ...entry(1), outcome: 'refused', reason: 'www.chase.com is on the list' }, 10);
    expect(line).toMatchObject({ outcome: 'refused', reason: 'www.chase.com is on the list' });
  });
});

describe('auditHost', () => {
  it('records the host and not the address, so a search term never lands in the log', () => {
    expect(auditHost('https://app.example.com/orders?q=customer+name&token=abc')).toBe('app.example.com');
    expect(auditHost('http://localhost:5173/x')).toBe('localhost');
    expect(auditHost('https://user:pw@www.paypal.com:8443/x')).toBe('www.paypal.com');
  });

  it('says so plainly when there was no page', () => {
    expect(auditHost(null)).toBe('—');
    expect(auditHost('')).toBe('—');
  });
});

describe('auditFromStorage', () => {
  it('reads back what was written', () => {
    const log = [entry(1), entry(2)];
    expect(auditFromStorage(JSON.parse(JSON.stringify(log)))).toEqual(log);
  });

  it('drops whatever else is in storage rather than drawing it', () => {
    expect(auditFromStorage([entry(1), null, 'nonsense', { at: 'yesterday' }, {}])).toEqual([entry(1)]);
    expect(auditFromStorage('not a log')).toEqual([]);
    expect(auditFromStorage(undefined)).toEqual([]);
  });
});
