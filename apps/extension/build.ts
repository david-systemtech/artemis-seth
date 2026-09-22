/**
 * Build `dist/` — a folder Chrome will load unpacked.
 * ============================================================================
 *
 * Three bundles, two pages, a stylesheet, four icons and a manifest. esbuild
 * rather than Vite because there is nothing here Vite would do: no dev server
 * (an extension is reloaded by Chrome, not by HMR), no framework, no CSS
 * pipeline. esbuild is already in the tree as Vite's own dependency.
 *
 * ## Nothing is minified, deliberately
 *
 * This extension asks for the `debugger` permission in a browser full of the
 * user's sessions. Whoever reviews that — a person loading it unpacked, or a
 * Web Store reviewer later — should be able to read what they are loading, and
 * a minified bundle answers "what does this do" with a wall. The whole of
 * `dist/` is a few tens of kilobytes either way.
 *
 * ## The version follows the desktop app
 *
 * Read from `apps/desktop/package.json` at build time. An extension loaded
 * unpacked does not update itself, so Artemis has to be able to say "the
 * extension in your browser is older than this app", and it can only do that if
 * the two numbers mean the same thing.
 *
 * Chrome's `version` is one to four dot-separated integers and nothing else, so
 * a prerelease suffix like `2.19.1-beta.2` is trimmed to `2.19.1` rather than
 * rejected — the desktop's own versions carry suffixes during a release run.
 */

import { deflateSync } from 'node:zlib';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { extensionManifest } from './src/manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

/** Where the built extension goes unless a caller says otherwise. */
export const DEFAULT_OUT_DIR = join(here, 'dist');

/** The desktop app's version, trimmed to what Chrome will accept. */
export async function desktopVersion(): Promise<string> {
  const text = await readFile(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8');
  const declared = String((JSON.parse(text) as { version?: unknown }).version ?? '0.0.0');
  const numeric = /^(\d+(?:\.\d+){0,3})/u.exec(declared);
  return numeric === null ? '0.0.0' : (numeric[1] as string);
}

/**
 * Build the extension into `outDir`, and return where it went.
 *
 * Exported because the end-to-end test builds its own copy into a temporary
 * directory and loads *that* into Chrome. A test that asserted against a
 * `dist/` somebody had built earlier would pass on a stale bundle.
 */
export async function buildExtension(outDir: string = DEFAULT_OUT_DIR): Promise<string> {
  const protocol = join(repoRoot, 'packages', 'protocol', 'dist', 'index.js');
  if (!existsSync(protocol)) {
    throw new Error(`@rx-artemis/protocol has not been built (${protocol} is missing). Run \`pnpm run build:libs\` at the repository root first.`);
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, 'icons'), { recursive: true });

  await build({
    entryPoints: {
      worker: join(here, 'src', 'worker.ts'),
      options: join(here, 'src', 'ui', 'options.ts'),
      popup: join(here, 'src', 'ui', 'popup.ts'),
    },
    outdir: outDir,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    // Matches `minimum_chrome_version` in the manifest. Nothing is transpiled
    // further down than the oldest browser that can run this extension at all.
    target: ['chrome116'],
    minify: false,
    sourcemap: false,
    legalComments: 'inline',
    logLevel: 'silent',
  });

  for (const file of ['options.html', 'popup.html', 'ui.css']) {
    await writeFile(join(outDir, file), await readFile(join(here, 'src', 'ui', file)));
  }

  for (const size of [16, 32, 48, 128]) {
    await writeFile(join(outDir, 'icons', `icon-${String(size)}.png`), icon(size));
  }

  const manifest = extensionManifest(await desktopVersion());
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return outDir;
}

/* -------------------------------------------------------------------------- */
/* Icons                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The toolbar icon, drawn rather than checked in.
 *
 * A purple disc with a white ring and crosshair — a target, which is the one
 * thing "Artemis" and "this is driving your browser" have in common. Generated
 * because a binary in a repository is a thing nobody can review or diff, and
 * four sizes of it are four such things. If the app ever gets a real mark this
 * function is replaced by reading it.
 */
function icon(size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  const outer = size * 0.46;
  const ring = size * 0.3;
  const stroke = Math.max(1, size / 16);
  const arm = size * 0.42;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - centre;
      const dy = y - centre;
      const radius = Math.hypot(dx, dy);
      const offset = (y * size + x) * 4;

      if (radius > outer) continue; // transparent outside the disc
      const onRing = Math.abs(radius - ring) <= stroke / 2;
      const onArm = (Math.abs(dx) <= stroke / 2 && Math.abs(dy) <= arm) || (Math.abs(dy) <= stroke / 2 && Math.abs(dx) <= arm);
      const white = onRing || onArm || radius <= stroke;

      pixels[offset] = white ? 0xff : 0x7c;
      pixels[offset + 1] = white ? 0xff : 0x5c;
      pixels[offset + 2] = white ? 0xff : 0xff;
      pixels[offset + 3] = 0xff;
    }
  }
  return png(size, size, pixels);
}

/** An 8-bit RGBA PNG. The whole format, for the one case this needs. */
function png(width: number, height: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  // 10..12 are compression, filter and interlace methods, all zero: the only
  // values the specification defines.

  // Each scanline is prefixed with its filter type. Zero — "none" — because
  // these images are flat colour and a filter would save nothing.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* -------------------------------------------------------------------------- */

// `pnpm --filter @rx-artemis/extension build` lands here. Compared as URLs,
// because `argv[1]` is a path and `import.meta.url` is a URL: on Windows the
// path is `C:\…` and the URL is `file:///C:/…`, and a string comparison of the
// two never matched, so `tsx build.ts` there exited 0 having built nothing.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = await buildExtension();
  process.stdout.write(`extension built into ${out}\n`);
}
