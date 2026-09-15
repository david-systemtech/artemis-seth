# Artemis in the terminal

The same accounts, models and permission controls as the desktop app, drawn
with Ink and driven in-process. One binary, `artemis`, opens a conversation in
the current directory; `artemis --help` lists the flags.

```
artemis                         open a conversation here
artemis --profile work          …as a particular account
artemis --model fable --mode plan
artemis -c                      pick up the newest conversation in this directory
artemis -p "what does this repo do?"   one turn, answer on stdout, exit
```

From a source checkout: `pnpm tui`.

## The screen

```
┌ header ── logo · tagline ─────────────────────────── directory ────┐
│ conversations│ transcript (bottom-anchored, scrolls by line)        │
│  ▾ folder    │ ⠹ Explore  auth call sites    1m 12s · Grep · 24k   │  delegated work
│    session   │ Todo  2/5 · » run the migration              Ctrl+T │  the checklist
│  ▸ folder    │ Queued · ↑ takes the newest back                    │  what is waiting to be read
│              │ permission card / picker / preview, when open        │
│              │ ╭ composer ─────────────────────────────────────╮   │
│              │ ╰────────────────────────────────────────────────╯   │
│              │ account · model · ⏸ ask             5hr · Week · …  │
│              │ ⠹ Read app.tsx · 1m 04s · 2.3k tok · Esc interrupts │
└──────────────┴─────────────────────────────────────────────────────┘
```

Tab rounds the composer, the conversation list and the delegated strip. `?` on
an empty composer opens the full key map; what follows is the same map.

## Keys

**Anywhere.** `Tab` round the composer, the list and the strip · `Shift+Tab`
step the permission mode on · `Esc` interrupt, or follow the end again ·
`Esc Esc` go back to an earlier prompt · `Ctrl+C` interrupt, again to quit ·
`Ctrl+O` unfold the whole transcript · `Ctrl+T` show or hide the checklist ·
`Ctrl+]` go to the next conversation that needs you · `?` open the key map.

**Writing a message.** `Enter` send, steer a turn, or run the highlighted
row · `Shift+Enter` / `Ctrl+J` a newline · a trailing `\` keeps the line open ·
`↑` / `↓` the text, then the queue, then history · `/` a command and its menu ·
`@` a file and the paths that match · `Tab` fill in the highlighted row · `!`
run a shell command (`!!` sends the output to the agent) · `Ctrl+V` paste an
image, or the text on the clipboard · `Ctrl+G` edit the draft in `$EDITOR`.

**Moving and editing.** `Ctrl+A` / `Home` and `Ctrl+E` / `End` the line's
ends · `Ctrl+Home` / `Ctrl+End` the buffer's · `Alt+B` / `Alt+F` a word back
or on · `Ctrl+W` rub out the word before the cursor · `Alt+D` the word after ·
`Ctrl+U` / `Ctrl+K` cut to the start or end of the line · `Ctrl+Y` put it
back · `Ctrl+_` undo · `Backspace` takes a whole paste chip.

**What you typed before.** `Ctrl+R` search back through past prompts; inside
the search, `Ctrl+R` steps older, `Ctrl+S` widens the scope, `Tab` keeps the
match to edit, `Enter` sends it, `Esc` restores the draft. Outside a search,
`Ctrl+S` stashes the draft and, on an empty box, brings it back.

**The conversation.** `PgUp` / `PgDn` or `Shift`/`Ctrl` with an arrow half a
screen · `End` back to the end, following it.

**The conversation list.** `↑` / `↓` (`k` / `j`) move · `Enter` open, or fold a
folder · type to filter, `/` starts a filter, `Backspace` rubs one off, `Esc`
clears it · `Space` preview · `a` archive · `d` delete · `p` pin; while a
filter is being typed those letters type, and `Ctrl+A` / `Ctrl+D` / `Ctrl+P`
do their work.

**Delegated work.** `↑` / `↓` move · `Enter` open what that agent did · `x`
stop the task · `→` / `←` unfold and fold a workflow's agents · `Esc` back.

**A list to choose from.** `↑` / `↓` move · letters filter · `Enter` choose ·
`Space` preview · `Ctrl+R` rename · `Ctrl+A` archive · `Ctrl+P` pin · `Esc`
clear the query, then close.

**A permission card.** `↑` / `↓` move · `Enter` choose · `Esc` deny (on a
question, skip) · `Tab` a line for why, or what to do after · `e` edit the rule
that row would save · `s` walk the scope it is saved at · `Space` tick one of
several options. The cursor opens on Deny and a bare Enter never authorises.

**The whole transcript** (`Ctrl+O`). `j` / `k` a line · `Space` / `b` a screen ·
`Ctrl+D` / `Ctrl+U` half · `g` / `G` the ends · `}` / `{` the next and previous
turn · `/` search, `n` / `N` between matches · `v` open in your editor · `q`
close.

## Several conversations at once

Conversations you switch away from keep working. The status line counts
the ones that need you, in yellow; `Ctrl+]` steps to the next one — first
those stopped on a permission, then those whose turn finished since you
last looked. Come back after a few minutes away and the first key shows
one line saying what finished, with its time and cost, and what is waiting.

Under each finished turn the row says what it cost the plan as well as in
tokens and dollars: `2.1% of 5hr · 0.4% of week`, for the windows that
moved while it ran. A tool that has run three minutes with nothing back
turns its row amber and says how long it has been quiet.

## Commands

| command | what it does |
| --- | --- |
| `/profile` | Switch the account the next conversation runs as |
| `/model` | Choose the model, and its effort where it has one |
| `/mode` | Set the permission mode for the next turn |
| `/resume` | Pick up a stored conversation from this directory |
| `/attach <path>` | Send an image or file with the next message |
| `/copy` | Copy the last reply, or one of its code blocks, to the clipboard |
| `/export [file]` | Write this conversation to a markdown file |
| `/diff` | What this conversation changed, and the working tree's diff |
| `/undo` | Take back the last file change the agent made |
| `/pin` | Keep this conversation at the top of its folder |
| `/title <name>` | Name this conversation |
| `/tasks` | Background work: what is running, and what a delegated agent did |
| `/usage` | The account's plan windows and how full they are |
| `/cwd` | Choose where to work: a folder you have used, or browse for one |
| `/new` | Start a fresh conversation on the same account |
| `/help` | The key map and these commands |
| `/quit` | Leave |

A `/command` the terminal does not know is sent to the agent as typed, so the
provider's own commands and your skills stay reachable; the menu offers them
by the word after the colon.

## From a script

```
artemis ls                      the stored conversations here: id, updated, branch, title
artemis ls --all --json         every directory, one JSON object per line
artemis -p "…" --output-format json          one document at the end
artemis -p "…" --output-format stream-json   every event as it arrives, then the document
```

A paste of more than three lines becomes a chip that says what it is —
`[Pasted #1 · 84 lines · Node stack trace from app.tsx:1442]` — and goes out
fenced with its language when it is code, a diff, JSON or a log.

## What it remembers, and where

The state directory (`~/.local/state/artemis/tui` on Linux, the platform's
equivalent elsewhere, or `ARTEMIS_TUI_STATE_DIR`) holds the preferences — last
account, model per account, mode, pinned conversations — the prompt history
(`history.jsonl`, append-only, capped) and the files you have picked with `@`.
Losing any of it costs a setting, never a launch.

## The terminal around it

The tab's title says what Artemis is doing — ready, working, or how many
conversations need you — and a bell or a desktop notice fires when a
permission has waited six seconds, or a turn finished a minute ago, and no key
has been pressed since. `ARTEMIS_TUI_NO_TITLE=1` keeps the title alone;
`ARTEMIS_TUI_NOTIFY=off` silences the bell, or names a method (`osc9`,
`osc777`, `bell`) for a terminal the sniffing cannot see, as over SSH. Diffs
are tinted on a terminal that declares `COLORTERM=truecolor`, and gain line
numbers from a hundred columns up. Links are clickable where the terminal
draws OSC 8 hyperlinks.
