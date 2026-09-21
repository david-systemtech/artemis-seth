# A browser for served runs

A proposal, not a decision. Written 2026-09-21 for David and Seth to pull apart.

## The gap

A run on an Artemis Server has no browser. The embedded browser is a
`WebContentsView` in the desktop's main process (`apps/desktop/main/browser.ts`),
its tools are built there because they touch a `webContents`
(`browserTools.ts`), and a headless server has neither. So an agent working on
a web app from a server can run the tests and cannot look at the page. It
cannot check that a form submits, read the console error behind a blank screen,
or see that the layout broke. It says "done" on the strength of a green suite.

Claude in Chrome (#435) is a different thing and does not close this: it is
Claude-only, it is the account owner's real browser with their real logins, and
pointing it at `localhost:3000` on the server means a tunnel from a laptop back
to the container. This proposal is the other half: a browser that belongs to
the server, signed in to nothing, for testing what the agent just built.

## Shape

```text
served run ──▶ artemisBrowser tools ──▶ PageDriver (interface, in core)
                                          ├─ Electron WebContents   desktop, today's behaviour
                                          └─ CDP client             server, new
                                                 │  ws://browser:9222, inside the compose network
                                                 ▼
                                          headless Chromium, its own container
```

Three pieces.

**1. A `PageDriver` interface in `packages/core`.** The six tool verbs today
(`open`, `navigate`, `read`, `screenshot`, `click`, `type`) are written straight
against Electron's `webContents`. Lift the verbs onto an interface: load, read
text, screenshot, click at a selector, type, plus two new ones below. The tool
definitions then move into core, which may not import Electron and will not have
to. The desktop implements the interface over `webContents` exactly as now. ADR
0005 already made the tool server a seam every adapter reaches; this makes what
is behind it swappable too.

**2. A CDP implementation, and a Chromium it talks to.** Chrome DevTools
Protocol over one WebSocket: `Page.navigate`, `Page.captureScreenshot`,
`Runtime.evaluate` for the readable-text extraction the desktop already does,
`Input.dispatchMouseEvent` / `insertText`. No Playwright in the server: a CDP
client is a few hundred lines with no native build, and Playwright is a 600 MB
dependency whose job here would be to send those same messages.

Chromium runs as **its own container** beside the server, not inside it:

- The server image stays as it is. Someone who never enables this pays nothing,
  not in image size and not in memory.
- The browser gets its own memory limit. The server has none, and has been
  OOM-killed by a session that ran a headless browser among other things
  (cortex: `artemis-server-parallel-agents-oom`). A browser that leaks takes
  itself down, not the agents.
- It can reach the server's dev servers over the compose network
  (`http://artemis-server:3000`), which is the whole use.

**3. Two verbs the desktop lacks, because testing needs them.**
`browser_console` (messages and uncaught errors since the last call) and
`browser_network` (failed and slow requests, status and URL only, no bodies or
headers). These are what turn "the page is blank" into "`/api/orders` returned
500". Both come from CDP events on the server and from `webContents` events on
the desktop, so both hosts get them.

Still no `browser_evaluate`, for the reason `browserTools.ts` gives. On a
browser with no logins the argument is weaker, but one tool surface across hosts
is worth more than the verb.

## What it costs, measured

On the server container, 2026-09-21, Playwright's `chromium_headless_shell`
141 driven over raw CDP:

| | |
|---|---|
| On disk | 323 MB (headless shell; full Chromium is 606 MB) |
| Memory, idle on `about:blank` | about 270 MB across its processes |
| Memory, one real page (a GitHub repository) | about 360 MB |
| Screenshot, 1280 px JPEG q70 | 45 kB in 83 ms |
| Start to first CDP answer | under 1 s |

RSS summed across processes counts shared pages more than once, so these are
ceilings. One browser is cheap. Seven agents each opening one is 2.5 GB, which
is why the limits below are part of the design and not tuning.

## Seeing what the agent sees

`browserTools.ts` opens with the rule that the agent drives **the page the user
is watching**, and rejects a Playwright MCP server for giving the agent "a
browser nobody could see". A headless browser in a container is exactly that
unless the picture comes back.

`Page.startScreencast` pushes JPEG frames on change: at the measured 45 kB a
frame and a few frames a second while something is happening, a few hundred
kilobytes a second in bursts. The push feed already carries terminal output to
a remote window; whether it carries frames comfortably over a tailnet has not
been measured and should be before this is built. So: the server
publishes frames on the feed as a new surface kind, and the desktop's browser
dock draws them for a served conversation where it draws a `WebContentsView` for
a local one. Read-only at first: the user watches, the agent drives. Surfaces
belong to conversations (ADR 0002), and this is one more.

This is the largest piece and the one most worth cutting from a first version.
A first version without it still has `browser_screenshot`, which puts a picture
in the transcript on request.

## Limits

- **One browser context per run, closed with the run.** Contexts are CDP's
  isolated profiles: separate cookies and storage in one Chromium process, so
  two agents testing the same app do not share a login. Targeting is by closure,
  as now: no tool takes a browser id.
- **A cap on live contexts per server** (default 2), refused with a sentence the
  model can read rather than queued.
- **Idle contexts close** after a few minutes; a run that comes back gets a
  fresh one and is told so.
- **A memory limit on the container**, 1 GB by default.

## Where it may go

The scheme gate in `browserUrlFor` carries over. On a server there is a second
question the desktop never had: this browser sits **inside the operator's
network**, next to everything the container can route to. An agent that can
browse from there can read an unauthenticated admin page on the LAN.

- Default allow: the compose network and loopback of the server (the dev
  servers, which are the point) and the public internet.
- Default deny: private ranges (RFC 1918, link-local, the tailnet's CGNAT range)
  other than the server itself, and cloud metadata addresses. An operator who
  wants the agent testing something on the LAN names it.
- Enforced in the driver on every navigation **and** at the network level by
  the container's own network, since a page can fetch what the agent never
  navigated to.

Every call still goes through `canUseTool`, so the user sees
`browser_navigate` with its URL and answers it, as now.

## Turning it on

Off by default. An operator adds the browser service to their compose file and
sets `ARTEMIS_BROWSER_CDP_URL=ws://browser:9222`. With the variable unset the
server offers no browser tools and nothing else changes. The catalogue publishes
whether a host has a browser, so a client can say so instead of showing tools
that are not there.

## Order of work

1. `PageDriver` in core, the desktop moved onto it, tools moved into core. No
   behaviour change; the existing `browserTools.test.ts` is the proof.
2. The CDP driver, tested against a fake CDP endpoint, plus one smoke script
   against a real Chromium.
3. Server wiring: the env variable, per-run contexts, the caps, the URL policy,
   the catalogue flag, the compose service.
4. `browser_console` and `browser_network`, on both hosts.
5. The screencast surface in the desktop dock.

Steps 1 to 3 make a served agent able to test a web app. Step 4 makes it good at
it. Step 5 lets a person watch.

## Testing Artemis itself

Not this. Driving Artemis's own Electron window from the server needs a virtual
display (Xvfb) and a working native build in the container, where `node-pty`
currently fails to compile (cortex: `artemis-dev-traps-on-the-agent-container`).
Worth doing, since the renderer is only ever driven through jsdom there, but it
is a CI job and a separate piece of work.

## Open questions

- **Playwright's Chromium build or Debian's?** Playwright's is pinned and is
  what was measured; Debian's updates with the image. A browser that reads the
  open web wants security updates more than it wants pinning.
- **One Chromium for the whole server, or one per account?** Contexts isolate
  cookies, not a renderer exploit. One per server is proposed; a shared server
  with mutually distrusting users may want more.
- **Should the agent be able to sign in to a test account?** Typing a password
  into a form already works. Whether a context's storage may persist between
  runs of one conversation, so it need not sign in each turn, is a convenience
  with an obvious cost.
- **Does the screencast need to be interactive?** Letting the user click in the
  dock means input events travelling the other way, and a second driver of a
  page the agent is driving.
