# A browser for served runs

Proposed 2026-09-21 for David and Seth to pull apart; built the same day. This
was the proposal and is now the record: what was built, what differs from what
was proposed and why, and what is deferred. The operator-facing half — how to
turn it on, what each variable does — is `docs/SERVER-BROWSER.md`.

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
to the container. This is the other half: a browser that belongs to the server,
signed in to nothing, for testing what the agent just built.

## Shape, as built

```text
served run ──▶ artemisBrowser tools ──▶ PageDriver (interface, in protocol)
                                          ├─ EmbeddedPageDriver  desktop, WebContents
                                          └─ CdpPageDriver       server, new
                                                 │  one WebSocket, flattened sessions
                                                 ▼
                                          headless Chromium, its own container
```

Five files in `packages/core/src/browser/`, and the split between them is the
one thing here worth arguing with:

| File | What it owns |
|---|---|
| `cdp.ts` | One WebSocket: correlation, session routing, deadlines. And `resolveCdpEndpoint`, which is where the Host-header trap lives. |
| `cdpPage.ts` | One attached target: what a verb *is* on the protocol. No policy, no lifecycle. |
| `serverBrowserPolicy.ts` | Where the browser may go. One pure function. |
| `serverBrowser.ts` | Contexts, caps, clocks, the watchdog, the sweep, the idle exit. |
| `cdpPageDriver.ts` | `PageDriver`: the policy gate, the redirect re-check, the refusal wording. |

Plus `servedBrowser.ts`, which is one pure function deciding which browser a
served run gets — the sibling of the desktop's `agentBrowserServers`, kept apart
from `host.ts` so that the third driver (the user's own Chrome, relayed through
the desktop client) lands in one obvious place. `cdpPageDriver.ts` talks to
`serverBrowser.ts` through a `PageLease` interface, so the driver's decisions
can be asserted against a fake tab with no socket anywhere.

**A CDP client and no Playwright**, as proposed: a few hundred lines with no
native build, against a 600 MB dependency whose job here would be to send the
same messages.

**No `ws` dependency either.** Node 22 has a global `WebSocket` and it is
sufficient: measured against Chromium 141, it connects to the DevTools endpoint
with no extra arguments and sends no `Origin` header, so `--remote-allow-origins`
is not needed. `ws` is in the lockfile as a transitive dependency of the MCP SDK,
and depending on a package that arrived under something else is how a workspace
ends up with a version it never chose. The one thing the WHATWG API cannot do is
set request headers — see the Host-header note below, which is handled by
resolving the name rather than by setting one.

Chromium runs as **its own container** beside the server, not inside it, for the
three reasons proposed: the server image is unchanged, the browser gets its own
memory limit, and it can reach the server's dev servers over the compose
network.

## What differs from the proposal

**The verbs.** The proposal stopped at `browser_console` and `browser_network`
and kept `browser_evaluate` out, on the reasoning `browserTools.ts` gives. The
contract that arrived (`packages/protocol/src/browserDriver.ts`, written for
three browsers rather than two) settles this differently and this driver follows
it: a `server` driver has all five deep verbs, including `cookies`, `storage`
and `evaluate`, because it is signed in to nothing. The argument against
`evaluate` is about a browser holding the user's logins. This one holds none:
every context is made for a run and thrown away with it.

**The block list is not reused.** `DEFAULT_BLOCKED_SITES` is a list of banks and
password managers, and it exists because the embedded and extension browsers
hold the user's sessions. Applying it here would refuse an agent a public help
page and prevent nothing. What this browser has instead is a position — inside
the operator's network — so the rule is inverted. See "Where it may go".

**One tab per run, so the three-tab rule is dropped.** The proposal said "at
most three tabs in a context; opening a fourth closes the least recently used".
The contract has no tab id on any verb — `PageDriver` targets by closure — so a
second tab would be a tab no tool could name. There is nothing for the rule to
bound, so it is not implemented and not implemented-and-disabled. A window a
*page* opens is closed by the sweep, for the same reason.

**A context closes with its run, and "its run" means one turn.** The proposal
said contexts close with their run; in practice a `PageDriver` is built per run
(the `agentToolServers` seam is per run) and nothing in the contract closes one
— `PageDriver.close` exists and the desktop never calls it, because its tab
belongs to the user's dock. Here the tab is nobody's, so `apps/server/src/host.ts`
closes it from the registry's lifecycle feed when the run ends. Without that, a
conversation taking three quick turns would meet a limit meant for three
conversations. The cost is that a page does not survive to the next turn; the
agent calls `browser_open` with the address, which is a sentence in the tool's
description rather than a failure.

**`Browser.close` is used, and that needed deciding.** The proposal said "the
server asks Chromium to exit, and starts it again on the next `browser_open`".
The server cannot start it: the connection mode is `ARTEMIS_BROWSER_CDP_URL`, a
container this process did not create. So the exit is only safe where something
else brings the browser back, and the recommended compose service says
`restart: unless-stopped` precisely so that something does. Under that policy
the exit returns the browser's memory to zero, which is the only way to be sure
a leaked renderer is really gone. `ARTEMIS_BROWSER_IDLE_EXIT=0` is for a
deployment that cannot take it; it keeps the process, not the pages.

**The screencast is deferred**, which the proposal itself said was the piece
most worth cutting. See below.

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

### What CDP can say about a tab's memory

Measured against the same build, because the watchdog depends on it and the
answer is not what the protocol documentation suggests:

- **`Runtime.getHeapUsage` is what is used.** One call, two numbers:
  `usedSize` (V8) and `embedderHeapUsedSize` (Blink's Oilpan heap — the DOM and
  what hangs off it). Their sum is what the ceiling is compared against. A blank
  page reads about 1.6 MB; allocating a two-million-element array moved
  `usedSize` from 0.35 MB to 8.5 MB, so it tracks a real leak.
- **`Performance.getMetrics`** reports the same V8 figure as `JSHeapUsedSize`,
  and needs `Performance.enable` on. No extra information for a domain more.
- **`SystemInfo.getProcessInfo` answers with `cpuTime` only** — no memory at all
  on this build. It is also per process, and a renderer is shared between
  same-site targets, so it could not attribute anything to a tab even if it
  carried the number.
- **`Memory.getDOMCounters`** counts nodes, not bytes.

So the ceiling is a floor on what a renderer really holds: it counts neither the
process's own overhead nor decoded images nor compositing surfaces. The
container's `mem_limit` is the backstop behind it, and that is why it is in the
compose file rather than being a suggestion.

## The Host-header trap

Chromium refuses an HTTP request to its DevTools port whose `Host` header is
neither an IP literal nor `localhost`, answering `500 Host header is specified
and is not an IP address or localhost`. So `http://browser:9222/json/version` —
the obvious thing to write in a compose file — does not work, and Node's WHATWG
`WebSocket` cannot set a header to work around it.

`resolveCdpEndpoint` resolves the hostname and makes the discovery request to
the address. Chromium echoes the `Host` it was given straight back into
`webSocketDebuggerUrl`, so the endpoint that comes back already names the
address; this was measured through a TCP relay standing in for the compose
service, which is also the fallback if a Chromium build ever stops honouring
`--remote-debugging-address`. Measured at the same time: the **WebSocket
upgrade** is not Host-checked on this build at all, only the plain `/json/*`
documents are. Resolving anyway costs one DNS lookup and removes a dependency on
that staying true.

## Seeing what the agent sees — deferred

`browserTools.ts` opens with the rule that the agent drives **the page the user
is watching**, and a headless browser in a container is exactly the "browser
nobody could see" it rejects a Playwright MCP server for. `Page.startScreencast`
would close that: JPEG frames on change, at the measured 45 kB a frame, drawn in
the desktop's browser dock for a served conversation as a new surface kind (ADR
0002).

It is deferred to **issue #439**, for the reason the proposal gave: it is the
largest piece and the one most worth cutting from a first version. Whether the
push feed carries a few hundred kilobytes a second comfortably over a tailnet
has not been measured, and should be before it is built. Until then
`browser_screenshot` puts a picture in the transcript on request, and the tool
wording tells the model it is the only way to show the user anything.

## Nothing outlives its use

The failure to design against is a browser that holds memory for pages nobody
is looking at. It is not hypothetical: a Firefox container on the same host was
found holding 2.4 GB for a single tab (David, 2026-09-21). Chromium does not
hand memory back to the system readily either, so closing tabs is necessary and
not sufficient. Built as five rules, in `serverBrowser.ts`:

- **A tab closes when it has not been used.** Ten minutes without a *tool call*
  by default — page activity does not count, because a page with a `setInterval`
  is not a conversation that is using it. The agent is told in the next tool
  result ("the browser tab for this conversation was closed after 10 minutes
  without a browser tool call… `browser_open` starts a new one") rather than
  finding out from an error. `browser_open` clears the notice without repeating
  it, because opening is what the notice asked for.
- **A context closes with its run**, and holds one tab. Contexts are CDP's
  isolated profiles: separate cookies and storage in one Chromium process, so
  two agents testing the same app do not share a login. Targeting is by closure:
  no tool takes a browser id.
- **The browser itself stops when nothing is open.** Five minutes with no live
  context and the server asks Chromium to exit; the next `browser_open`
  reconnects, retrying while the container comes back. An idle server then holds
  no browser memory at all, and every fresh start is back at the 270 MB baseline
  instead of wherever the last session left the heap. This is the rule that
  answers the 2.4 GB tab.
- **A watchdog for the case the clocks miss.** Per-tab heap on a thirty-second
  interval; a tab past 500 MB by default is closed, least recently used first,
  and the agent is told how much it was holding. The container's own 1 GB limit
  is the backstop behind that.
- **A cap on live contexts per server** (default 2), refused with a sentence the
  model can act on — wait, or close a browser it has finished with — rather than
  queued behind a lock it cannot see.

And **a sweep on connecting**: a server that crashed may have left tabs behind
in a browser that outlived it, so on connecting it closes every target and
disposes every context it does not own. Measured: closing every target leaves
Chromium 141 running with none, so the sweep cannot take the browser down by
tidying.

Every clock is injectable, and `ServerBrowser.maintain()` is public, so every
rule above is tested without waiting for any of it — against the fake CDP
endpoint in `serverBrowser.test.ts` and against a real Chromium in
`cdpBrowser.integration.test.ts`.

Each of these is a number an operator can change. None of them can be turned
off. `ARTEMIS_BROWSER_IDLE_EXIT` is the only boolean, and it chooses between two
ways of giving memory back rather than a way of keeping it.

## Where it may go

This browser sits **inside the operator's network**, next to everything the
container can route to. An agent that can browse from there can read an
unauthenticated admin page on the LAN, or the cloud metadata service.

- **Allowed**: the public internet, plus the internal hosts an operator named in
  `ARTEMIS_BROWSER_ALLOW_HOSTS`, added to a default of `localhost`, `127.0.0.1`,
  `::1` and `artemis-server`.
- **Refused**: private ranges, link-local, the tailnet's CGNAT range, IPv6
  unique-local, and `.local` / `.internal` / `.lan` names, unless named.
- **Refused whatever the allow-list says**: the cloud metadata addresses
  (`169.254.169.254`, `169.254.170.2`, `fd00:ec2::254`,
  `metadata.google.internal`). What is behind them is the host's own
  credentials.

Enforced in the driver before every navigation **and** against the address the
page actually has after every load, because a public address that redirects to a
private one is the whole attack and the first check cannot see it. A page that
got somewhere it should not be is left on `about:blank`.

It does **not** cover a loaded page's own sub-requests: an `<img src>` or a
`fetch()` happens inside Chromium's network stack, below anything CDP lets a
client veto without `Fetch.enable` on every request — which would put an Artemis
round trip in front of every subresource of every page. The fence for that is
the container's network, and the compose file ships the guidance:
`docs/SERVER-BROWSER.md`, "What that does not cover".

Every call still goes through `canUseTool`, so the user sees `browser_navigate`
with its URL and answers it, as now — an MCP tool is a tool, and only
`suggest_task` is exempt. Prompts on the `/v1/chat/completions` surface are
auto-denied, as they always were: there is nobody behind an HTTP chat request to
ask.

## Turning it on

Off by default. `ARTEMIS_BROWSER_CDP_URL=http://browser:9222` and the compose
service; with the variable unset the server offers no browser tools and nothing
else changes. The catalogue publishes whether a host has one —
`ServerConnectionInfo.serverBrowser` on `GET /api/v0/connection` — so a client
can say so instead of leaving a user to wonder. Full instructions and every
variable: `docs/SERVER-BROWSER.md`.

## Order of work, as it went

1. `PageDriver` in protocol, the desktop moved onto it, tools moved into core.
   No behaviour change; `browserTools.test.ts` was the proof. **Done.**
2. The CDP driver, against a fake CDP endpoint and against a real Chromium.
   **Done** — the smoke script became an integration test that skips itself
   where there is no browser.
3. Server wiring: the env variables, per-run contexts, the caps, the URL policy,
   the catalogue flag, the compose service. **Done.**
4. `browser_console` and `browser_network` on both hosts. **Done**, and on this
   host `browser_cookies`, `browser_storage` and `browser_evaluate` as well.
5. The screencast surface in the desktop dock. **Deferred to #439.**

## Testing Artemis itself

Not this. Driving Artemis's own Electron window from the server needs a virtual
display (Xvfb) and a working native build in the container, where `node-pty`
currently fails to compile (cortex: `artemis-dev-traps-on-the-agent-container`).
Worth doing, since the renderer is only ever driven through jsdom there, but it
is a CI job and a separate piece of work.

## Questions the build answered, and the ones it did not

**Playwright's Chromium build or Debian's?** Debian's, in
`docker/browser.Dockerfile`. A browser that reads the open web on an agent's
instruction wants security updates more than it wants pinning, and a rebuild is
a shorter path to one than waiting for somebody else's tag. What is given up is
a pinned revision: an apt upgrade can change behaviour between two builds. One
measured caveat: Playwright's `chromium_headless_shell` ignores
`--remote-debugging-address` and binds loopback whatever it is given, which is
why the image uses the full browser.

**One Chromium for the whole server, or one per account?** One per server, as
proposed. Contexts isolate cookies, not a renderer exploit; a shared server with
mutually distrusting users may want more, and would get it by running a second
browser container and a second server.

**Should the agent be able to sign in to a test account?** Typing a password
into a form already works. Storage persisting between turns of one conversation
does not: the context closes with the run. Not revisited.

**Does the screencast need to be interactive?** Still open, and now #439's.
