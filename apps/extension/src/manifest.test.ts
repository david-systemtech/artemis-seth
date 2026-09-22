/**
 * The manifest is the only part of an extension a user is shown before they
 * trust it. A permission that appeared without an argument in `manifest.ts`
 * should fail a test, not reach a review.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { EXTENSION_ID, EXTENSION_KEY, extensionManifest, MANIFEST_PERMISSIONS } from './manifest.js';

const manifest = extensionManifest('2.19.1');

describe('the manifest', () => {
  it('asks for four permissions and no more', () => {
    expect(manifest.permissions).toEqual(['debugger', 'tabGroups', 'storage', 'alarms']);
    expect(MANIFEST_PERMISSIONS).toHaveLength(4);
  });

  it('does not ask to read the user’s browsing, and does not need to', () => {
    // `tabs` reads as "Read your browsing history" in Chrome's install prompt.
    // Measured, not assumed: tabs.create, tabs.group, tabs.remove and
    // tabGroups.update all work without it, and a tab's address comes from the
    // debugger session on Artemis's own tab.
    expect(manifest.permissions).not.toContain('tabs');
    expect(manifest.permissions).not.toContain('cookies');
    expect(manifest.permissions).not.toContain('scripting');
    expect(manifest.permissions).not.toContain('webRequest');
  });

  it('asks for no host permissions at all, because a WebSocket to loopback needs none', () => {
    expect(manifest).not.toHaveProperty('host_permissions');
    expect(manifest).not.toHaveProperty('content_scripts');
  });

  it('allows no remote code and no network but the bridge', () => {
    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('connect-src');
    expect(csp).toContain('ws://127.0.0.1:*');
    expect(csp).not.toMatch(/\bhttps?:/u);
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('unsafe-inline');
  });

  it('permits exactly the one address the extension dials, and no other name for it', () => {
    /*
     * `ws://localhost:*` was here, argued for by a scenario no code path
     * reaches: `bridgeUrl` builds the literal `127.0.0.1` and `isBridgeUrl`
     * rejects everything else, so the socket that entry would have permitted
     * is one this extension refuses to open. A CSP that is wider than the code
     * is a CSP that stops being a second opinion — it says the browser would
     * allow something, and the only reason it does not happen is that the
     * code currently declines to ask.
     *
     * The rule this pins is the general one, not the removal: `connect-src`
     * names what is dialled.
     */
    const csp = manifest.content_security_policy.extension_pages;
    const connect = /connect-src ([^;]+);/u.exec(csp)?.[1]?.trim().split(/\s+/u) ?? [];
    expect(connect).toEqual(["'self'", 'ws://127.0.0.1:*']);
  });

  it('follows the desktop app’s version, trimmed to what Chrome will accept', () => {
    expect(extensionManifest('2.19.1').version).toBe('2.19.1');
  });

  it('is an MV3 extension with a worker, a popup and an options page', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: 'worker.js', type: 'module' });
    expect(manifest.options_page).toBe('options.html');
    expect(manifest.action.default_popup).toBe('popup.html');
  });
});

describe('the extension id', () => {
  it('is the one the committed key produces, so it is the same on every machine', () => {
    // Chrome's derivation: the first sixteen bytes of the public key's SHA-256,
    // each nibble mapped from 0-f onto a-p.
    const digest = createHash('sha256').update(Buffer.from(EXTENSION_KEY, 'base64')).digest('hex').slice(0, 32);
    const derived = [...digest].map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join('');
    expect(derived).toBe(EXTENSION_ID);
    expect(manifest.key).toBe(EXTENSION_KEY);
  });

  it('is a public key and not a private one', () => {
    const der = Buffer.from(EXTENSION_KEY, 'base64');
    // A SubjectPublicKeyInfo for RSA begins with this sequence header; a PKCS#8
    // private key does not. The check exists because committing the wrong half
    // of this pair is the one mistake here that could not be taken back.
    expect(der.subarray(0, 12).toString('hex')).toBe('30820122300d06092a864886');
    expect(EXTENSION_KEY).not.toContain('PRIVATE');
  });
});
