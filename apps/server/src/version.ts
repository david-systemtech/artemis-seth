/**
 * Which Artemis release this server is.
 *
 * `/health` and the index at `/` used to say `0.1.0-headless` whatever was
 * running: a string typed once and never touched, so the one question a person
 * asks a server first — "is it on the release I think it is?" — had no answer
 * there. The honest one was a container label on the host.
 *
 * A release is one version across every artifact it ships, and
 * `apps/desktop/package.json` is where it is written: `release.yml` refuses a
 * tag that disagrees with it, and the terminal UI is stamped from it when it
 * is packaged (`scripts/package-tui.ts`). The server follows the same rule, in
 * the two places it runs from:
 *
 *  - **A checkout** — `pnpm --filter @rx-artemis/server build` and running
 *    `apps/server/dist/main.js`, or the tests running `src/`. The workspace is
 *    right there, so the desktop's manifest is read directly.
 *  - **The container image**, which carries none of the desktop app. The
 *    Dockerfile stamps the release version onto this package's own manifest
 *    while it builds, and proves it by running `--version` on what it built.
 *
 * So the order is the workspace's release manifest, then this package's own.
 * Its own comes second because in a checkout it says `0.1.0` — the server has
 * never been versioned on its own, and a second number to keep in step would
 * be the next thing to drift.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What {@link serverVersion} answers when neither manifest can be read. */
export const UNKNOWN_VERSION = 'unknown';

/** The desktop package's name: a manifest that says otherwise is not the release's. */
const RELEASE_PACKAGE = '@rx-artemis/desktop';

/** The folder the running code is in — `dist/` when built, `src/` under the tests. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** A manifest's `name` and `version`, or `null` when it cannot be read as one. */
function readManifest(file: string): { readonly name?: unknown; readonly version?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function versionOf(manifest: { readonly version?: unknown } | null): string | null {
  const version = manifest?.version;
  return typeof version === 'string' && version.trim().length > 0 ? version.trim() : null;
}

/**
 * The release version, read from the manifests beside `codeDir`.
 *
 * `codeDir` is the folder the server's code runs from, and defaults to the real
 * one; tests pass a scratch layout. Read once per call and never throws: a
 * server that cannot say its version still serves.
 */
export function serverVersion(codeDir: string = HERE): string {
  // A checkout: apps/server/{dist,src} → apps/desktop/package.json. Checked by
  // name, because in the image this path lands outside the app entirely, and
  // whatever might be there is not ours to report.
  const release = readManifest(join(codeDir, '..', '..', 'desktop', 'package.json'));
  if (release?.name === RELEASE_PACKAGE) {
    const version = versionOf(release);
    if (version !== null) return version;
  }
  // The image: this package's own manifest, which the Dockerfile stamped.
  return versionOf(readManifest(join(codeDir, '..', 'package.json'))) ?? UNKNOWN_VERSION;
}
