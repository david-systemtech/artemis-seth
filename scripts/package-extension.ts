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
 * ## The archive is written here rather than shelled out for
 *
 * Rejected: `zip`, which is the obvious answer and is missing on Windows and
 * on more than one container this repo is built in — so the script would work
 * for some people and print a confusing failure for the rest. Rejected also:
 * an archiver dependency, to run one command in one CI job, in a workspace
 * whose protocol package has no dependencies at all.
 *
 * What is left is sixty lines of ZIP, and ZIP is a format sixty lines can
 * write correctly when the inputs are this modest: a few dozen text files,
 * none of them four gigabytes, no directory entries needed because every path
 * is a file. `zlib.deflateRawSync` does the compression and is in Node. The
 * one thing to be careful about is the one thing this format gets people on —
 * separators — and {@link entriesOf} states the rule.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

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
    // The workspace's own entry point for it, so this script and a developer
    // typing `pnpm build:extension` run the same thing. It builds the protocol
    // package first, which the extension imports.
    run('pnpm', ['run', 'build:extension'], root);
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

  /*
   * Only the archives are cleared. The directory itself is committed — holding
   * a README — because `electron-builder.yml`'s `extraResources` copies from
   * it and a missing source directory fails the package.
   */
  mkdirSync(outputDir, { recursive: true });
  for (const name of readdirSync(outputDir)) {
    if (name.endsWith('.zip')) rmSync(join(outputDir, name));
  }

  const archive = join(outputDir, `artemis-extension-${version}.zip`);
  writeFileSync(archive, zipOf(dist));
  say(`Wrote ${archive}`);
}

/* -------------------------------------------------------------------------- */
/* A ZIP file                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every file under a directory, as the paths they will have in the archive.
 *
 * Relative to `dist` itself and **not** to its parent, so the archive's
 * entries are the extension's own files rather than a `dist/` folder
 * containing them. Chrome's "Load unpacked" wants the folder holding
 * `manifest.json`; a user who unzips an archive with one wrapper folder and
 * points Chrome at the wrapper gets "Manifest file is missing or unreadable"
 * and nothing to explain it.
 *
 * Separators are forced to `/`. A ZIP path is always `/`-separated, and an
 * archive built on Windows with backslashes in it extracts on macOS as files
 * whose names contain backslashes — one directory, wrong names, no error.
 */
function entriesOf(dir: string): readonly { readonly name: string; readonly body: Buffer }[] {
  const found: { name: string; body: Buffer }[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        found.push({ name: relative(dir, path).split(sep).join('/'), body: readFileSync(path) });
      }
    }
  };
  walk(dir);
  return found;
}

/**
 * The directory as one deflated ZIP, with a fixed timestamp.
 *
 * Fixed because the archive is a release artifact: two builds of the same
 * commit should produce the same bytes, and the only thing that would
 * otherwise differ is the minute they ran in. 1980-01-01 is the earliest
 * instant the format can express, which is the conventional stand-in for "no
 * meaningful time" and is what every reproducible-build toolchain writes.
 */
function zipOf(dir: string): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entriesOf(dir)) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.body);
    const crc = crc32(entry.body);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x0403_4b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(0, 10); // time
    header.writeUInt16LE(33, 12); // date: 1980-01-01
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(deflated.length, 18);
    header.writeUInt32LE(entry.body.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28); // extra
    local.push(header, name, deflated);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x0201_4b50, 0);
    record.writeUInt16LE(20, 4); // version made by
    record.writeUInt16LE(20, 6); // version needed
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(0, 12);
    record.writeUInt16LE(33, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(deflated.length, 20);
    record.writeUInt32LE(entry.body.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30); // extra
    record.writeUInt16LE(0, 32); // comment
    record.writeUInt16LE(0, 34); // disk
    record.writeUInt16LE(0, 36); // internal attrs
    // 0o644, in the high two bytes, where unix-made archives put their mode.
    // Without it some extractors give the files no read bit at all.
    record.writeUInt32LE((0o100_644 << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += header.length + name.length + deflated.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the directory
  end.writeUInt16LE(central.length / 2, 8); // entries on this disk
  end.writeUInt16LE(central.length / 2, 10); // entries in total
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment

  return Buffer.concat([...local, directory, end]);
}

/** CRC-32 as ZIP means it: the reflected polynomial, table-driven. */
function crc32(data: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] as number);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

const CRC_TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    }
    table.push(value >>> 0);
  }
  return table;
})();

main();
