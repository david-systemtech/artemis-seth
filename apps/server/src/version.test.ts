/**
 * Which release a server says it is.
 *
 * Over scratch directories shaped like the two places the server runs from — a
 * checkout of the workspace, and the container image's `/app` — because what
 * is being decided is which file on disk is the truth.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UNKNOWN_VERSION, serverVersion } from './version.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'artemis-server-version-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function manifest(file: string, body: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body));
}

describe('serverVersion', () => {
  it('reads the release from the desktop manifest in a checkout, not the server’s own 0.1.0', () => {
    manifest(join(root, 'apps', 'desktop', 'package.json'), { name: '@rx-artemis/desktop', version: '2.18.0' });
    manifest(join(root, 'apps', 'server', 'package.json'), { name: '@rx-artemis/server', version: '0.1.0' });

    expect(serverVersion(join(root, 'apps', 'server', 'dist'))).toBe('2.18.0');
    // The same answer from the sources, which is where the tests run.
    expect(serverVersion(join(root, 'apps', 'server', 'src'))).toBe('2.18.0');
  });

  it('reads the version the image build stamped on its own manifest', () => {
    // `/app/dist/main.js`, `/app/package.json`, and no desktop anywhere.
    manifest(join(root, 'app', 'package.json'), { name: '@rx-artemis/server', version: '2.18.0' });

    expect(serverVersion(join(root, 'app', 'dist'))).toBe('2.18.0');
  });

  it('ignores a manifest where the desktop’s would be that is not the desktop’s', () => {
    // In the image, `/app/dist/../../desktop` is `/desktop`, outside the app —
    // whatever happens to be there is somebody else's.
    manifest(join(root, 'desktop', 'package.json'), { name: 'something-else', version: '9.9.9' });
    manifest(join(root, 'app', 'package.json'), { name: '@rx-artemis/server', version: '2.18.0' });

    expect(serverVersion(join(root, 'app', 'dist'))).toBe('2.18.0');
  });

  it('falls back to its own manifest when the desktop’s cannot be read', () => {
    mkdirSync(join(root, 'apps', 'desktop'), { recursive: true });
    writeFileSync(join(root, 'apps', 'desktop', 'package.json'), '{ not json');
    manifest(join(root, 'apps', 'server', 'package.json'), { name: '@rx-artemis/server', version: '2.18.1' });

    expect(serverVersion(join(root, 'apps', 'server', 'dist'))).toBe('2.18.1');
  });

  it('says it does not know, rather than inventing a number or refusing to start', () => {
    expect(serverVersion(join(root, 'nowhere', 'dist'))).toBe(UNKNOWN_VERSION);
    manifest(join(root, 'app', 'package.json'), { name: '@rx-artemis/server', version: '   ' });
    expect(serverVersion(join(root, 'app', 'dist'))).toBe(UNKNOWN_VERSION);
  });

  it('reports this repository’s release, the number every other artifact of it carries', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const release = JSON.parse(
      readFileSync(join(here, '..', '..', 'desktop', 'package.json'), 'utf8'),
    ) as { version: string };

    expect(serverVersion()).toBe(release.version);
    expect(serverVersion()).not.toBe('0.1.0');
  });
});
