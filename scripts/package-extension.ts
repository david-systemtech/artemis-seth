/**
 * Build the browser extension and zip it for release.
 * ============================================================================
 *
 * Two consumers, one artifact:
 *
 *  - **The GitHub release.** `release.yml` attaches
 *    `artemis-extension-<version>.zip` beside the DMG and the EXE, so someone
 *    who did not install Artemis from this machine can still get the matching
 *    extension.
 *  - **The desktop app.** The same zip is copied into the packaged app as a
 *    resource (`extraResources` in `electron-builder.yml`), so Settings →
 *    Browser can hand it over with no network at all. That is the reason the
 *    version is in the *file name*: `main/index.ts` reads it without opening
 *    the archive, on every launch, to tell a paired browser its extension is
 *    behind.
 *
 * ## An absent extension is not a failure; a broken one is
 *
 * `apps/extension` is being built in parallel and does not exist on every
 * branch. A script that failed when it was missing would fail CI on every
 * branch that predates it, which teaches people to ignore the red. So:
 *
 *  - no `apps/extension/package.json` → say so and exit 0. Nothing was asked
 *    of us. The app ships without a bundled extension and the Browser pane
 *    says that in as many words.
 *  - the directory is there and its build fails, or it produces no `dist/` →
 *    exit non-zero. That is a broken extension, and shipping a build whose
 *    "Get the extension" button hands over the previous version's code is
 *    worse than not shipping.
 *
 * ## Why `zip` rather than a dependency
 *
 * `@rx-artemis/*` packages have deliberately few dependencies and the protocol
 * package has none at all. Adding an archiver to the workspace to run one
 * command in one CI job would be the wrong trade. `zip` is present on the
 * Linux and macOS runners and on every developer machine this repo is built
 * on; Windows has no `zip`, which is why the workflow runs this job on Linux
 * only and why a Windows developer's local package simply has no bundled
 * extension — the same honest state as a branch without `apps/extension`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = join(root, 'apps', 'extension');
/** Beside the desktop's other build resources, which is what gets packaged. */
const outputDir = join(root, 'apps', 'desktop', 'build', 'extension');

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`::error::${message}\n`);
  process.exit(1);
}

function run(command: string, args: readonly string[], cwd: string): void {
  execFileSync(command, [...args], { cwd, stdio: 'inherit' });
}

/** The version the app reports, which is the version the extension is named for. */
function appVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8'),
  );
  const version = (manifest as { version?: unknown }).version;
  if (typeof version !== 'string') fail('apps/desktop/package.json has no version.');
  return version;
}

function main(): void {
  if (!existsSync(join(extensionDir, 'package.json'))) {
    // Deliberately exit 0. See the header: this is the state of a branch that
    // predates the extension, not a broken build.
    say(
      'No apps/extension in this checkout, so there is no browser extension to package. ' +
        'The app will ship without a bundled extension, and Settings → Browser says so.',
    );
    return;
  }

  const version = appVersion();
  say(`Building the browser extension for Artemis ${version}.`);

  try {
    // `--frozen-lockfile` is the workspace install's business, already done by
    // the time this runs; this only asks the package for its own build.
    run('pnpm', ['--filter', './apps/extension', 'run', 'build'], root);
  } catch (error) {
    fail(
      'The browser extension failed to build. ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  const dist = join(extensionDir, 'dist');
  if (!existsSync(dist)) {
    fail(
      'The browser extension built without producing apps/extension/dist. ' +
        'That directory is what Chrome loads unpacked, and what this script zips.',
    );
  }

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const archive = join(outputDir, `artemis-extension-${version}.zip`);

  /*
   * Zipped from *inside* `dist`, so the archive's entries are the extension's
   * own files rather than a `dist/` folder containing them. Chrome's "Load
   * unpacked" wants the folder holding `manifest.json`, and a user who unzips
   * an archive with one wrapper folder and points Chrome at the wrapper gets
   * "Manifest file is missing or unreadable" with nothing to explain it.
   */
  try {
    run('zip', ['-r', '-q', '-X', archive, '.'], dist);
  } catch (error) {
    fail(
      'Could not zip the browser extension. This script needs `zip` on PATH; ' +
        'the release workflow runs it on Linux for that reason. ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  say(`Wrote ${archive}`);
}

main();
