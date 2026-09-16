/**
 * The clipboard, which is four different programs wearing one name.
 * ============================================================================
 *
 * A terminal has no clipboard of its own. Every other agent terminal pastes a
 * screenshot with Ctrl+V and copies a code block with Ctrl+Y, and each of them
 * does it by shelling out to whatever the desktop session happens to provide —
 * `pbpaste` on macOS, `wl-paste` under Wayland, `xclip` under X11,
 * `powershell.exe` on Windows and from inside WSL. That is the whole of this
 * module: the platform layer, none of the keys. The composer decides what a
 * keystroke means; this decides which program can answer it.
 *
 * Decisions worth knowing:
 *
 *  - **Nothing here throws.** A missing tool, an empty clipboard, a clipboard
 *    holding text when an image was asked for, a session with no display, a
 *    tool that hangs — all of them are `null`, because the caller is a
 *    keystroke and the only useful response to any of them is the same line in
 *    the status bar. Two seconds is the longest any of it may take: a paste
 *    that has not happened by then is a frozen prompt, and a frozen prompt is
 *    worse than a failed paste.
 *  - **WSL is Windows.** A copy inside WSL has to reach the Windows clipboard,
 *    because that is the clipboard the person pressed Ctrl+C in; the Linux
 *    tools are not installed and would be talking to nothing if they were. So
 *    the backend is chosen by where the clipboard *is*, not by `process.platform`.
 *  - **The image always comes back as PNG bytes**, verified by signature. Each
 *    tool is asked for PNG specifically, and the signature check is what turns
 *    "the clipboard held text" into `null` on the backends that answer with a
 *    zero exit status and an error message on stdout rather than a failure.
 *  - **A copy over SSH prefers OSC 52.** `pbcopy` on the machine the agent is
 *    running on writes to *that* machine's clipboard, which is not the one the
 *    person can paste from. OSC 52 hands the bytes to the terminal emulator
 *    they are sitting in front of, through however many hops of SSH and tmux.
 *    Which is why `copyText` says which route it took: "copied" and "sent to
 *    the terminal" are different promises, and OSC 52 is unacknowledgeable —
 *    the terminal may silently refuse it, and nothing can tell us so.
 *  - **Everything a test would have to own is a parameter.** The platform, the
 *    environment, the process runner, the stream the escape sequence goes to,
 *    and the PATH lookup: tests pass all five and assert the exact argv, so
 *    the suite never touches a real clipboard and passes identically on a
 *    machine that has none.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, constants, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, extname, join } from 'node:path';
import { promisify } from 'node:util';

import { MAX_ATTACHMENT_BYTES } from './attachments.js';

/** How long any clipboard tool gets before it is killed and disbelieved. */
export const CLIPBOARD_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// What this module needs from the world
// ---------------------------------------------------------------------------

/** What a clipboard tool is given and what it is asked for. */
export interface RunOptions {
  /** Written to the child's standard input, then closed. */
  readonly input?: string;
  /** How long the child gets. */
  readonly timeoutMs?: number;
  /** Most bytes to accept from the child's standard output. */
  readonly maxBytes?: number;
}

export interface RunResult {
  readonly stdout: Uint8Array;
}

/**
 * Run a program and collect its output as bytes. A non-zero exit, a timeout, a
 * missing executable and output past `maxBytes` are all rejections; the callers
 * here treat every one of them the same way.
 */
export type ExecFileLike = (file: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

/** Whether a bare command name can be found on `PATH`. */
export type WhichFn = (command: string) => Promise<boolean>;

/** The part of `process.stdout` an escape sequence needs. */
export interface StdoutLike {
  write(chunk: string): unknown;
  /** OSC 52 to something that is not a terminal goes into a file, so: only a terminal. */
  readonly isTTY?: boolean;
}

export interface ClipboardDeps {
  /** `process.platform`, or what a test says it is. */
  readonly platform?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly execFile?: ExecFileLike;
  /** Where OSC 52 is written. `process.stdout` by default. */
  readonly stdout?: StdoutLike;
  readonly which?: WhichFn;
  /**
   * The contents of `/proc/version`, read lazily from disk when absent. Only
   * WSL detection reads it, and only a test ever passes it — a suite running on
   * a WSL machine must still be able to exercise the Wayland and X11 branches.
   */
  readonly procVersion?: string;
}

interface Wired {
  readonly platform: string;
  readonly env: NodeJS.ProcessEnv;
  readonly execFile: ExecFileLike;
  readonly stdout: StdoutLike | undefined;
  readonly which: WhichFn;
  readonly procVersion: string | undefined;
}

const run = promisify(execFile);

/**
 * The default runner, and the only thing here that starts a process.
 *
 * `encoding: 'buffer'` because an image is not text. Standard input is closed
 * either way: a tool that reads it (`pbcopy`) must see the end of the text, and
 * a tool that does not (`pbpaste`) must not be left waiting on a pipe nobody
 * will ever write to.
 */
export const runClipboardTool: ExecFileLike = async (file, args, options) => {
  const pending = run(file, [...args], {
    encoding: 'buffer' as const,
    timeout: options.timeoutMs ?? CLIPBOARD_TIMEOUT_MS,
    maxBuffer: options.maxBytes ?? MAX_ATTACHMENT_BYTES + 1,
    windowsHide: true,
  });
  const stdin = pending.child.stdin;
  if (stdin !== null) {
    // A tool that has already decided to fail closes its end first; writing to
    // it then raises EPIPE, which is not news worth an unhandled error event.
    stdin.on('error', () => undefined);
    stdin.end(options.input ?? '');
  }
  const { stdout } = await pending;
  return { stdout };
};

function wire(deps: ClipboardDeps): Wired {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  return {
    platform,
    env,
    execFile: deps.execFile ?? runClipboardTool,
    stdout: deps.stdout ?? process.stdout,
    which: deps.which ?? ((command: string): Promise<boolean> => onPath(command, env, platform)),
    procVersion: deps.procVersion,
  };
}

// ---------------------------------------------------------------------------
// Which clipboard is this
// ---------------------------------------------------------------------------

/**
 * Whose clipboard the tools would be talking to.
 *
 * `'none'` is a session with no clipboard server at all — a headless SSH login,
 * a cron job, a platform nobody here has a tool for. It is not an error; it
 * means the only way to copy is to ask the terminal, and `copyText` gets there
 * without first paying for an `xclip` that was always going to fail.
 */
export type ClipboardBackend = 'macos' | 'wayland' | 'x11' | 'windows' | 'none';

/**
 * Synchronous on purpose: the UI wants to know what it can offer before it
 * draws a hint about it, and an `await` in that path would be a frame late.
 */
export function clipboardBackend(deps: ClipboardDeps = {}): ClipboardBackend {
  return backendOf(wire(deps));
}

function backendOf(deps: Wired): ClipboardBackend {
  if (deps.platform === 'darwin') return 'macos';
  if (deps.platform === 'win32') return 'windows';
  if (deps.platform !== 'linux') return 'none';
  if (isWsl(deps)) return 'windows';
  if (present(deps.env['WAYLAND_DISPLAY'])) return 'wayland';
  return present(deps.env['DISPLAY']) ? 'x11' : 'none';
}

const present = (value: string | undefined): boolean => value !== undefined && value.length > 0;

/**
 * WSL announces itself twice: the distribution's name in the environment, which
 * every shell inside it has, and the word "microsoft" in the kernel version,
 * which survives a login that inherited nothing.
 */
function isWsl(deps: Wired): boolean {
  if (present(deps.env['WSL_DISTRO_NAME'])) return true;
  return /microsoft/i.test(deps.procVersion ?? procVersion());
}

let cachedProcVersion: string | undefined;

/** Read once per process, synchronously: it is a few dozen bytes of procfs. */
function procVersion(): string {
  if (cachedProcVersion === undefined) {
    try {
      cachedProcVersion = readFileSync('/proc/version', 'utf8');
    } catch {
      cachedProcVersion = '';
    }
  }
  return cachedProcVersion;
}

// ---------------------------------------------------------------------------
// Finding a tool
// ---------------------------------------------------------------------------

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Whether `command` is on `PATH`, without spawning anything.
 *
 * Asking `which` would mean a process to find out whether a process is worth
 * starting, on a path taken for every copy. The lookup is the one the shell
 * does: each `PATH` entry in order, and on Windows each `PATHEXT` extension for
 * a name that does not already carry one. Executability is checked where it
 * means something; on Windows it does not, so existence is the whole test.
 */
export async function onPath(command: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Promise<boolean> {
  const windows = platform === 'win32';
  const raw = env['PATH'] ?? env['Path'] ?? '';
  const directories = raw.split(windows ? ';' : delimiter).filter((entry) => entry.length > 0);
  const extensions = windows && extname(command).length === 0 ? (env['PATHEXT'] ?? DEFAULT_PATHEXT).split(';').filter((entry) => entry.length > 0) : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      try {
        await access(join(directory, command + extension), windows ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        // Not here; try the next candidate.
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Reading an image
// ---------------------------------------------------------------------------

export interface ClipboardImage {
  readonly bytes: Uint8Array;
  readonly mediaType: 'image/png';
}

/** Eight bytes that every PNG starts with, and nothing else does. */
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/**
 * PowerShell, in one `-Command`, on both native Windows and WSL.
 *
 * The bytes come back base64 on standard output rather than through a temporary
 * file, which is the one arrangement that works in both places: from WSL a
 * Linux temp path is not something `powershell.exe` can open, and a Windows
 * temp path is not something WSL can be relied on to read back. One script is
 * also one script's worth of behaviour to test.
 */
const POWERSHELL_IMAGE_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Drawing',
  '$image = Get-Clipboard -Format Image',
  'if ($null -eq $image) { exit 1 }',
  '$stream = New-Object System.IO.MemoryStream',
  '$image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)',
  '[Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))',
].join('; ');

/** Enough room for a capped image once base64 has made it a third bigger. */
const MAX_BASE64_BYTES = Math.ceil(((MAX_ATTACHMENT_BYTES + 1) * 4) / 3) + 8;

/**
 * The image on the clipboard as PNG bytes, or `null` for every reason there is
 * not one: no tool, no image, no display, too large, too slow.
 */
export async function readClipboardImage(deps: ClipboardDeps = {}): Promise<ClipboardImage | null> {
  const wired = wire(deps);
  switch (backendOf(wired)) {
    case 'macos':
      // `pngpaste` writes the bytes and nothing else, so it wins when it is
      // installed. `osascript` cannot: asked for `«class PNGf»` it prints the
      // data as a hex literal on stdout, so the bytes have to be fetched by
      // having AppleScript `write` them to a file we then read.
      return asImage((await wired.which('pngpaste')) ? await bytesFrom(wired, 'pngpaste', ['-']) : await appleScriptImage(wired));
    case 'wayland':
      return asImage(await bytesFrom(wired, 'wl-paste', ['-t', 'image/png']));
    case 'x11':
      return asImage(await bytesFrom(wired, 'xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']));
    case 'windows':
      return asImage(await base64From(wired, POWERSHELL_IMAGE_SCRIPT));
    case 'none':
      return null;
  }
}

function asImage(bytes: Uint8Array | null): ClipboardImage | null {
  if (bytes === null || bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) return null;
  if (!startsWith(bytes, PNG_SIGNATURE)) return null;
  return { bytes, mediaType: 'image/png' };
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

/** Raw standard output, or `null` if the tool would not or could not answer. */
async function bytesFrom(deps: Wired, file: string, args: readonly string[]): Promise<Uint8Array | null> {
  try {
    const { stdout } = await deps.execFile(file, args, { timeoutMs: CLIPBOARD_TIMEOUT_MS, maxBytes: MAX_ATTACHMENT_BYTES + 1 });
    return stdout;
  } catch {
    return null;
  }
}

async function base64From(deps: Wired, script: string): Promise<Uint8Array | null> {
  try {
    const { stdout } = await deps.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeoutMs: CLIPBOARD_TIMEOUT_MS,
      maxBytes: MAX_BASE64_BYTES,
    });
    const encoded = Buffer.from(stdout).toString('utf8').trim();
    return encoded.length === 0 ? null : new Uint8Array(Buffer.from(encoded, 'base64'));
  } catch {
    return null;
  }
}

/**
 * The AppleScript fallback: a private directory, a file AppleScript writes the
 * clipboard's PNG representation into, and nothing left behind either way. The
 * directory goes even when the clipboard held no image, because the failure is
 * `osascript`'s and the mess would be ours.
 */
async function appleScriptImage(deps: Wired): Promise<Uint8Array | null> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'artemis-clipboard-'));
    const file = join(directory, 'clipboard.png');
    await deps.execFile(
      'osascript',
      [
        '-e',
        `set target to open for access POSIX file ${appleScriptString(file)} with write permission`,
        '-e',
        'write (the clipboard as «class PNGf») to target',
        '-e',
        'close access target',
      ],
      { timeoutMs: CLIPBOARD_TIMEOUT_MS },
    );
    return new Uint8Array(await readFile(file));
  } catch {
    return null;
  } finally {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** AppleScript string literals escape a backslash and a quote, and nothing else. */
const appleScriptString = (value: string): string => `"${value.replace(/[\\"]/g, (character) => `\\${character}`)}"`;

// ---------------------------------------------------------------------------
// Reading text
// ---------------------------------------------------------------------------

/**
 * `[Console]::OutputEncoding` first, because PowerShell's pipe defaults to the
 * console code page and would turn every accent into a question mark;
 * `[Console]::Out.Write` rather than the pipeline, because the pipeline adds a
 * newline the clipboard never had.
 */
const POWERSHELL_TEXT_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$text = Get-Clipboard -Raw',
  'if ($null -eq $text) { exit 1 }',
  '[Console]::Out.Write($text)',
].join('; ');

/**
 * The text on the clipboard, verbatim — line endings included, because the
 * composer's buffer is what decides what to do with a `\r\n`. `null` for an
 * empty clipboard, since pasting nothing is not something to report as a paste.
 */
export async function readClipboardText(deps: ClipboardDeps = {}): Promise<string | null> {
  const wired = wire(deps);
  const bytes = await (() => {
    switch (backendOf(wired)) {
      case 'macos':
        return bytesFrom(wired, 'pbpaste', []);
      case 'wayland':
        // `-n` so wl-paste does not add a newline the clipboard did not have.
        return bytesFrom(wired, 'wl-paste', ['-n']);
      case 'x11':
        // `-selection clipboard` because the default selection is PRIMARY, which
        // is whatever the mouse last swept over — not what anyone copied.
        return bytesFrom(wired, 'xclip', ['-selection', 'clipboard', '-o']);
      case 'windows':
        return textFrom(wired, POWERSHELL_TEXT_SCRIPT);
      case 'none':
        return Promise.resolve(null);
    }
  })();
  if (bytes === null || bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) return null;
  const text = Buffer.from(bytes).toString('utf8');
  return text.length === 0 ? null : text;
}

async function textFrom(deps: Wired, script: string): Promise<Uint8Array | null> {
  try {
    const { stdout } = await deps.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeoutMs: CLIPBOARD_TIMEOUT_MS,
      maxBytes: MAX_ATTACHMENT_BYTES + 1,
    });
    return stdout;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------

/**
 * Which route the text took. `'native'` is in the clipboard now; `'osc52'` was
 * handed to the terminal, which is as far as anything can know; `'none'` means
 * there was no route at all.
 */
export type CopyOutcome = 'native' | 'osc52' | 'none';

/** The tool that owns the clipboard, and the arguments that make it take stdin. */
function nativeCopy(backend: ClipboardBackend): { readonly file: string; readonly args: readonly string[] } | null {
  switch (backend) {
    case 'macos':
      return { file: 'pbcopy', args: [] };
    case 'wayland':
      return { file: 'wl-copy', args: [] };
    case 'x11':
      return { file: 'xclip', args: ['-selection', 'clipboard'] };
    case 'windows':
      return { file: 'clip.exe', args: [] };
    case 'none':
      return null;
  }
}

/**
 * Put `text` on the clipboard, and say how.
 *
 * Two routes, tried in the order that suits the session. Locally the native
 * tool is first: it is the real clipboard, it survives the terminal being
 * closed, and it needs no cooperation from the emulator. Over SSH the order
 * reverses — see the header. Either way the other route is still tried if the
 * first cannot run, so a copy from a remote shell in a terminal that ignores
 * OSC 52 still reaches the remote clipboard rather than nowhere.
 */
export async function copyText(text: string, deps: ClipboardDeps = {}): Promise<CopyOutcome> {
  if (text.length === 0) return 'none';
  const wired = wire(deps);
  const overSsh = present(wired.env['SSH_TTY']);
  const routes: readonly ('native' | 'osc52')[] = overSsh ? ['osc52', 'native'] : ['native', 'osc52'];
  for (const route of routes) {
    if (route === 'native' && (await copyNative(wired, text))) return 'native';
    if (route === 'osc52' && writeOsc52(wired, text)) return 'osc52';
  }
  return 'none';
}

async function copyNative(deps: Wired, text: string): Promise<boolean> {
  const tool = nativeCopy(backendOf(deps));
  if (tool === null) return false;
  if (!(await deps.which(tool.file))) return false;
  try {
    await deps.execFile(tool.file, tool.args, { input: text, timeoutMs: CLIPBOARD_TIMEOUT_MS });
    return true;
  } catch {
    // `xclip` lingers in the foreground to serve the selection it was given, so
    // the timeout that kills it is not evidence the text failed to land — but
    // it is not evidence it landed either, and the OSC 52 that follows costs
    // nothing and settles it.
    return false;
  }
}

/**
 * The escape sequence that asks the terminal to take `text`.
 *
 * Inside tmux the sequence would be consumed by tmux, so it is wrapped in a DCS
 * passthrough — which requires every escape byte inside it to be doubled,
 * hence the substitution rather than a concatenation.
 */
export function osc52Sequence(text: string, options: { readonly tmux?: boolean } = {}): string {
  const sequence = `\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`;
  return options.tmux === true ? `\u001bPtmux;${sequence.replaceAll('\u001b', '\u001b\u001b')}\u001b\\` : sequence;
}

/**
 * Write the sequence and nothing else — no cursor query, no mode change, no
 * newline. It is zero-width, so a terminal that does not understand it shows
 * nothing, and one that does says nothing back.
 */
function writeOsc52(deps: Wired, text: string): boolean {
  const stdout = deps.stdout;
  if (stdout === undefined || stdout.isTTY !== true) return false;
  try {
    stdout.write(osc52Sequence(text, { tmux: present(deps.env['TMUX']) }));
    return true;
  } catch {
    return false;
  }
}
