#!/usr/bin/env node
/**
 * `artemis` — Artemis in the terminal.
 *
 * The third front end over the same engine as the desktop app and the
 * headless server. This file is the entry and nothing more: it reads the
 * flags, resolves where Artemis's data lives, runs `launch()`, and then either
 * hands the terminal to Ink or — for `--print` — streams one turn and exits.
 *
 *   artemis                          open a conversation in this directory
 *   artemis --profile work           …as a particular account
 *   artemis --model fable --mode plan
 *   artemis -p "what does this repo do?"   one turn, answer on stdout
 *   artemis ls --json                stored conversations, one per line
 *
 * The last two are the whole scriptable surface, and both live outside the
 * screen: they run after `launch()` and return an exit code without Ink ever
 * being mounted, which is what lets them work down a pipe with no terminal at
 * all. What each writes is `print.ts` and `sessionsCli.ts`; this file only
 * decides which was asked for.
 *
 * Nothing here talks to a provider. That is `host.ts`, composed the way
 * `apps/server/src/host.ts` composes it, driven by `conversation.ts`, and drawn
 * by `app.tsx`.
 */


import { render } from 'ink';

import { App } from './app.js';
import { artemisDataDir } from './dataDir.js';
import { Frecency, defaultFrecencyPath } from './fileIndex.js';
import { launch } from './launch.js';
import { clearTitle, progressState } from './terminal.js';
import { currentVersion, installRoot, runUpdate } from './update.js';
import { OUTPUT_FORMATS, isOutputFormat, runPrint, type OutputFormat } from './print.js';
import { runSessionsList } from './sessionsCli.js';

/**
 * What `artemis` does instead of opening a conversation.
 *
 * A subcommand rather than a flag because it is a different verb: `ls` does not
 * start an agent, and a `--list` that quietly ignored `--model` would be
 * pretending otherwise. It is recognised only as the *first* argument, so a
 * prompt that happens to begin with the word is still a prompt.
 */
const COMMANDS = ['ls'] as const;
type Command = (typeof COMMANDS)[number];

interface Args {
  readonly command?: Command;
  readonly print?: string;
  readonly outputFormat?: OutputFormat;
  readonly profile?: string;
  readonly model?: string;
  readonly mode?: string;
  readonly cwd?: string;
  readonly resume?: string;
  /** `ls`: every directory rather than this one. */
  readonly all: boolean;
  /** `ls`: JSON Lines rather than a table. */
  readonly json: boolean;
  readonly help: boolean;
  readonly version: boolean;
  readonly update: boolean;
}

const USAGE = `Usage: artemis [options]
       artemis ls [--all] [--json]

  --profile <label>   the account to open on (default: the first usable one)
  --model <id>        the model, as the provider names it
  --mode <mode>       permission mode to start in (default, acceptEdits, plan, …)
  --cwd <path>        work in this directory instead of the current one
  -c, --continue      pick up the newest conversation in this directory
  -r, --resume <id>   pick up a particular stored conversation
  -p, --print <text>  send one message, write the answer to stdout, exit
  --output-format <f> with --print: text (default) | json | stream-json
  --update            replace an installed copy with the latest release
  -v, --version
  -h, --help

  ls                  stored conversations here, newest first, as
                      "id  updated  branch  title"
    --all             every directory, not only this one
    --json            one JSON object per line, for piping

Data directory: ${artemisDataDir()}  (set ARTEMIS_DATA_DIR to move it)
`;

function parseArgs(input: readonly string[]): Args | string {
  const command = COMMANDS.find((name) => name === input[0]);
  const argv = command === undefined ? input : input.slice(1);
  const out: { -readonly [K in keyof Args]: Args[K] } = {
    help: false,
    version: false,
    update: false,
    all: false,
    json: false,
    ...(command === undefined ? {} : { command }),
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = (): string | undefined => argv[++i];
    switch (arg) {
      case '-h':
      case '--help':
        out.help = true;
        break;
      case '-v':
      case '--version':
        out.version = true;
        break;
      case '--update':
        out.update = true;
        break;
      case '--profile':
        out.profile = next();
        break;
      case '--model':
        out.model = next();
        break;
      case '--mode':
        out.mode = next();
        break;
      case '--cwd':
        out.cwd = next();
        break;
      case '-c':
      case '--continue':
        out.resume = 'latest';
        break;
      case '-r':
      case '--resume':
        out.resume = next() ?? 'latest';
        break;
      case '-p':
      case '--print':
        out.print = next() ?? '';
        break;
      case '--output-format': {
        const format = next() ?? '';
        if (!isOutputFormat(format)) return `--output-format takes ${OUTPUT_FORMATS.join(', ')} — not "${format}"\n\n${USAGE}`;
        out.outputFormat = format;
        break;
      }
      case '--all':
        out.all = true;
        break;
      case '--json':
        out.json = true;
        break;
      default:
        if (arg.startsWith('-')) return `Unknown option ${arg}\n\n${USAGE}`;
        rest.push(arg);
    }
  }
  // `artemis -p what does this do` — words after the prompt join it.
  if (out.print !== undefined && rest.length > 0) out.print = [out.print, ...rest].join(' ').trim();
  else if (rest.length > 0) return `Unexpected argument "${rest[0] ?? ''}"\n\n${USAGE}`;
  /*
   * A flag that belongs to another verb is a typo, not a preference: someone
   * who typed `artemis --json` wanted a listing and would otherwise get a
   * terminal, and someone who typed `--output-format json` without `--print`
   * would get one where they expected a document on stdout.
   */
  if (out.command === undefined && (out.all || out.json)) return `--all and --json belong to "artemis ls".\n\n${USAGE}`;
  if (out.command !== undefined && out.print !== undefined) return `"artemis ${out.command}" does not take a message.\n\n${USAGE}`;
  if (out.outputFormat !== undefined && out.print === undefined) return `--output-format applies to --print.\n\n${USAGE}`;
  return out;
}


async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === 'string') {
    process.stderr.write(parsed);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`artemis ${currentVersion()}\n`);
    return 0;
  }
  if (parsed.update) {
    const root = installRoot();
    if (root === undefined) {
      process.stderr.write('This copy runs from a source checkout; update it with git pull, then pnpm tui.\n');
      return 1;
    }
    return runUpdate(root);
  }

  const result = await launch({
    dataDir: artemisDataDir(),
    cwd: parsed.cwd ?? process.cwd(),
    ...(parsed.profile === undefined ? {} : { profile: parsed.profile }),
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    ...(parsed.mode === undefined ? {} : { mode: parsed.mode }),
    ...(parsed.resume === undefined ? {} : { resume: parsed.resume }),
  });
  if (!result.ok) {
    process.stderr.write(`${result.error}\n`);
    return 1;
  }
  const { launched } = result;

  /** Where `--print` and `ls` write. The one screenless surface both share. */
  const io = {
    stdout: (text: string) => process.stdout.write(text),
    stderr: (text: string) => process.stderr.write(text),
  };

  /*
   * Which files `@` offers first, remembered between runs. Only the terminal
   * has one: the scriptable paths complete nothing, and saving from there would
   * write an empty file over a real one.
   */
  let files: Frecency | undefined;

  try {
    if (parsed.command === 'ls') {
      return await runSessionsList(launched, { all: parsed.all, json: parsed.json }, io);
    }

    if (parsed.print !== undefined) {
      if (parsed.print.trim().length === 0) {
        process.stderr.write('--print needs a message.\n');
        return 2;
      }
      return await runPrint(launched, parsed.print, io, {
        ...(parsed.outputFormat === undefined ? {} : { format: parsed.outputFormat }),
      });
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write('artemis needs a terminal. For scripts, use: artemis --print "<message>"\n');
      return 2;
    }

    files = new Frecency(defaultFrecencyPath());
    await files.load();

    // The whole terminal, on the alternate screen: what was on it before is
    // restored on exit, and the app draws to the size it is given.
    const instance = render(<App launched={launched} files={files} />, { exitOnCtrlC: false, alternateScreen: true });
    await instance.waitUntilExit();
    return 0;
  } finally {
    /*
     * Hand the window back. The title and the taskbar light belong to Artemis
     * only while it is running, and a shell prompt left under `⠹ working` or
     * behind a taskbar button still pulsing is a window that lies about a
     * process that has exited. Here rather than in an unmount effect because
     * this runs on every way out of a launched session — the `--print` path
     * included, where both are no-ops off a terminal, which is exactly what
     * they should be. See `terminal.ts` for why there is no restore, only a
     * clear: a title stack needs a pop on every exit, including the ones that
     * are a crash, and an unbalanced one leaves the *wrong* title behind.
     */
    clearTitle();
    progressState('clear');
    await launched.cache.flush();
    await launched.preferences.flush();
    await launched.history.flush();
    // Saving a snippet returns before the rename does — see `snippets.ts` — so
    // a `/snip save` followed immediately by `/quit` is the write this waits
    // for. Nothing to flush on the `--print` path, where nobody saved one.
    await launched.snippets.flush();
    await files?.save();
    await launched.host.dispose();
  }
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
