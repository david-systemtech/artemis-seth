# A browser for served runs

An agent on an Artemis Server can run your tests. Without this it cannot look at
the page: it cannot check that a form submits, read the console error behind a
blank screen, or see that the layout broke, so it says "done" on the strength of
a green suite. Turn this on and it gets a headless Chromium of its own, beside
the server, signed in to nothing.

Off by default. With `ARTEMIS_BROWSER_CDP_URL` unset the server offers no
browser tools and nothing else about your deployment changes.

## Turning it on

The browser runs in **its own container**. The server image stays as it is:
somebody who never enables this pays nothing, not in image size and not in
memory, and a browser that leaks takes itself down rather than the agents.

In `docker/docker-compose.yml`, uncomment three things — they are marked:

1. the `browser` service;
2. `ARTEMIS_BROWSER_CDP_URL` (and any limits you want to change) on the
   `artemis` service;
3. the `networks:` block at the foot of the file, and the `networks:` list on
   the `artemis` service.

Then:

```
docker compose -f docker/docker-compose.yml up -d --build
```

The image is built from `docker/browser.Dockerfile`: Debian slim, Debian's own
`chromium`, running as a non-root user, with a DevTools port and nothing else.
Built here rather than pulled from a third party so that a Chromium security
update is a rebuild rather than a wait for somebody else's tag to move — this is
the container in the stack most worth keeping patched, because it loads whatever
an agent and the open web hand it.

Check it came up:

```
docker compose -f docker/docker-compose.yml exec artemis \
  curl -fsS "http://$(getent hosts browser | cut -d' ' -f1):9222/json/version"
```

Note the `getent`: Chromium refuses an HTTP request to its DevTools port whose
`Host` header is a name rather than an address, and answers `500 Host header is
specified and is not an IP address or localhost`. Artemis resolves the name for
you — write `http://browser:9222` in the compose file and it does the lookup —
but a health check you type by hand has to do the same.

A client can ask whether a server has one: `GET /api/v0/connection` carries
`serverBrowser: true` where it does.

## What the agent gets

The same tool names the desktop's dock browser answers to, so a permission
allow-list you built for one works for the other:

| Tool | What it does |
|---|---|
| `browser_open` | Open this conversation's tab, optionally at an address |
| `browser_navigate` | Go somewhere, and wait for the load to settle |
| `browser_read` | The page's readable text (`innerText`, not markup) |
| `browser_screenshot` | A JPEG of the fold, 1280×800 |
| `browser_click` | A real click at the centre of an element's box |
| `browser_type` | Replace a field's contents, firing `input` and `change` |
| `browser_console` | Console lines and uncaught errors since the last call |
| `browser_network` | Requests since the last call: method, status, type, duration |
| `browser_cookies` | The cookies the page would send, with values |
| `browser_storage` | `localStorage` and `sessionStorage` for the origin |
| `browser_evaluate` | A JavaScript expression, returning JSON |

The last five are offered here and not on the desktop's dock browser, and the
difference is the browser rather than the tools. The dock browser's session is
the one the *user* signs into inside Artemis, so a tool that could read a cookie
value there could read their live session on every site they had visited. This
browser has no logins at all: a context is made for one run and thrown away with
it, so a cookie here is test data the agent or the application put there.

Every call still goes through the permission prompt. An MCP tool is a tool, so
the user sees `browser_navigate` with its URL and answers it, exactly as they
answer `Bash`. The one exception is not this feature's: a run started through
`/v1/chat/completions` has nobody behind it to ask, and its prompts are
auto-denied as they always were.

**One tab per conversation, and it closes with the turn.** Targeting is by
closure — no tool takes a tab id, so an agent cannot name a page that is not its
own — and a window a page opens with `window.open` is closed, because no tool
could have driven it. A page does not survive to the next turn: an agent that
wants to look again calls `browser_open` with the address.

## Where it may go

This browser sits inside your network. It can route to everything its container
can route to, which is the point — `http://artemis-server:3000` is the dev
server the agent is testing — and also the danger: an unauthenticated admin page
on the LAN, or the cloud metadata service.

So the rule is the opposite of a normal block list:

- **The public internet is open.** There are no logins here to spend, so there
  is nothing to protect by refusing a bank's public help page.
- **Everything internal is shut** — loopback, RFC 1918, link-local, CGNAT, IPv6
  unique-local, and `.local` / `.internal` / `.lan` names — **unless you named
  it.** `ARTEMIS_BROWSER_ALLOW_HOSTS` is a comma-separated list, added to the
  defaults (`localhost`, `127.0.0.1`, `::1`, `artemis-server`). Wildcards work:
  `*.corp.example`.
- **Cloud metadata addresses are refused whatever you write** —
  `169.254.169.254`, `169.254.170.2`, `fd00:ec2::254`,
  `metadata.google.internal`. What is behind them is the host machine's own
  credentials, which is not something an operator can mean to allow.

Those two sentences are about **every frame of the page, not only the page**. A
frame is as readable through `browser_screenshot` — Chromium renders cross-origin
frames into the same image — and as clickable through `browser_click`, which aims
at viewport coordinates, as the page around it. And the agent can write one:
`browser_evaluate` appending an `<iframe src="…">` is a navigation no tool call
names. So a frame is judged exactly as the page is, and **a page one of whose
frames is refused is refused whole**: the tab goes to `about:blank` and the agent
is told on its next call. That does refuse a page for an address a third party
embedded — there is nothing that could tell the agent's `<iframe>` from the
document's — and for a browser sitting inside your network that is the right way
round. A page you need that embeds an internal host is a host to put in
`ARTEMIS_BROWSER_ALLOW_HOSTS`; the metadata list is the part of it with no
switch.

### A name is not an address

Applying those rules to the spelling of the host would be a spelling check:
`169.254.169.254.nip.io` is a public name for the metadata service, and anybody
can mint an A record pointing wherever they like. So the rule is applied three
times, to two different things.

1. **The name**, before anything else. Cheap, and it catches the obvious cases.
2. **What the name resolves to**, before navigating, using the container's own
   resolver — the one Chromium is about to use. A metadata address is refused
   whatever the name is and whatever your allow-list says. A private address is
   refused unless the *name* is on the allow-list: `artemis-server` and
   `localhost` resolve into private space by design, and refusing them would
   refuse the dev servers this exists for. A name that will not resolve is
   refused, in the resolver's own words.
3. **The address Chromium actually connected to** for the main document, after
   every load. This is the only one that catches a name which resolved publicly
   when Artemis looked and privately by the time the browser fetched it.

Checked before navigating, on **every** navigation the browser makes in **every**
frame — including a `<meta http-equiv="refresh">`, a `history.pushState`, a timer
calling `location.assign`, and an `<iframe>` that appears after the page has
loaded, none of which any tool asked for — and again before every verb acts. A
page that got somewhere it should not be is left on `about:blank`, and the agent
is told on its next call.

A cross-site frame under site isolation is a separate process with its own
DevTools target, and it reports nothing on the page's own `Page` domain. The tab
auto-attaches to those, so they are judged through the target they became rather
than being invisible. What such a frame does not carry is the address it was
served from, so it is held by its name and by the metadata list; a frame that
stays in the page is held by its name **and** by the machine its own document
really came from, which is the rebinding check one frame down.

### What that does not cover, and what does

The policy gates **navigation**. It does **not** gate the requests a loaded page
makes for itself: a `fetch`, an `XMLHttpRequest`, an `<img src>`, a stylesheet,
a font, a `sendBeacon`. Those reach an address without navigating anything, so
none of the events above fires for them, and vetoing them would mean an Artemis
round trip in front of every subresource of every page.

That is a narrower hole than it sounds, and the difference is worth being plain
about. A frame could be *read back* — rendered into a screenshot, clicked, typed
into. A `fetch()` cannot: nothing renders it and no verb returns it, so what a
sub-request can do is reach an address, not report what it found. It is still a
`GET` your network will see.

Nor can the third check say anything about a document with **no** remote
address — a `data:` page, or one served from a cache. Those are held by the
first two alone. The gap is narrow here rather than silent: `Network.enable` is
on for every tab, which disables that tab's disk cache, so a document served
from cache is a case this browser does not have.

The fence for that is at the network level and nowhere else. The compose file
puts the browser on a network with exactly one other container on it, which
stops anything else reaching the DevTools port but does not stop the browser
reaching your private space — Docker's bridge networks are symmetrical. If your
network has things on it that an unauthenticated `GET` would damage, give the
browser an egress rule: allow the server and the public internet, deny the rest.
On plain Docker that is an iptables rule or an egress proxy; under Kubernetes it
is a `NetworkPolicy`.

## Nothing outlives its use

A browser that holds memory for pages nobody is looking at is the failure this
was designed against. It is not hypothetical: a Firefox container on the same
host was found holding 2.4 GB for a single tab. Five rules, and **none of them
can be switched off** — each is a number you may change.

| Rule | Default | Variable |
|---|---|---|
| A tab with no tool call for N minutes is closed | 10 | `ARTEMIS_BROWSER_IDLE_MINUTES` |
| At most N conversations have a browser at once | 2 | `ARTEMIS_BROWSER_MAX_CONTEXTS` |
| A tab past N MB of heap is closed, least recently used first | 500 | `ARTEMIS_BROWSER_TAB_MEMORY_MB` |
| With nothing open for five minutes, Chromium is asked to exit | on | `ARTEMIS_BROWSER_IDLE_EXIT` |
| On connecting, every target this server does not own is closed | always | — |

The agent is told what happened on its next call — "the tab was closed after 10
minutes without a browser tool call… `browser_open` starts a new one" — rather
than meeting a verb that fails for no stated reason. A run refused for the
context cap is told to wait or to close a browser it has finished with, which is
something it can act on; it is not queued behind a lock it cannot see.

**Why the exit.** Chromium does not hand a freed heap back to the operating
system readily, so closing tabs is necessary and not sufficient. A process that
has exited holds nothing, and the next `browser_open` reconnects — with retries,
because the container is coming back up. That is why the compose service says
`restart: unless-stopped`: the restart policy is what makes the exit safe. If
you run the browser under something that will *not* restart it, set
`ARTEMIS_BROWSER_IDLE_EXIT=0`. That does not keep the pages — every context
still closes, and Chromium is asked to free what it can — it only leaves the
process up. It is strictly worse, and the variable exists so the default can be
the good one.

**Why the memory ceiling is not the whole story.** CDP can report a tab's
*heap*: `Runtime.getHeapUsage` gives V8's used size and Blink's, and that is
what the ceiling is compared against. It counts neither the renderer process's
own overhead nor decoded images nor compositing surfaces, which on a heavy page
are most of it. (Measured on Chromium 141: `SystemInfo.getProcessInfo` answers
with `cpuTime` only — no memory figures at all — and is per process rather than
per tab, so it could not attribute anything to a tab even if it carried them.)
So keep `mem_limit: 1g` on the browser service. The per-tab ceiling is the first
line; the container's limit is the backstop.

## What has not been run

The Docker packaging was written where there is no Docker, so it is reasoned
rather than proved: the image has not been built and the compose file has not
been brought up. What *was* measured, against a headless Chromium 141 started by
hand on 2026-09-21:

- Node 22's platform `WebSocket` connects to the DevTools endpoint with no extra
  arguments and sends no `Origin` header, so `--remote-allow-origins` is not
  needed.
- `/json/version` refuses a name in the `Host` header and accepts an address,
  and echoes whichever address it was given back into `webSocketDebuggerUrl` —
  including through a TCP relay standing in for the compose service. The
  **WebSocket upgrade** is not Host-checked at all on that build; only the plain
  `/json/*` documents are.
- Closing every target leaves the browser running with none, so the sweep cannot
  take the browser down by tidying.
- Playwright's `chromium_headless_shell` **ignores** `--remote-debugging-address`
  and binds loopback whatever it is given. Debian's full `chromium` is what the
  Dockerfile uses, and honours the switch. If a future build stops honouring it,
  the fix is a relay in front — `socat TCP-LISTEN:9222,fork,reuseaddr
  TCP:127.0.0.1:9223` — which was measured to preserve everything the server
  needs.

And on 2026-09-22, against the same headless shell:

- **`--user-data-dir` is in the image's CMD and is not optional.** Since Chrome
  136 a `--remote-debugging-port` is ignored unless a non-default profile
  directory is given with it. The measurement does not settle it: started with
  the port and *without* the flag, the headless shell opened the port in about a
  second and created no `~/.config/chromium`, because it makes itself a
  throwaway profile and so satisfies the rule without being told to. The image
  runs the **full** browser under `--headless=new`, which uses the default
  profile — the case the rule refuses. So the flag is reasoned from the rule and
  from a binary that sidesteps it, and the only thing that would prove it is a
  build of this image, which there is still no Docker here to do.
- **A cross-site frame is its own target when site isolation is on.** Under
  `--site-per-process` an iframe on another site reported no
  `Page.frameNavigated` on the page's session and did not appear in
  `Page.getFrameTree`; with `Target.setAutoAttach` it arrived as
  `Target.attachedToTarget` with `type: "iframe"` and an empty url, and the url
  followed on `Target.targetInfoChanged`, as did every later navigation of it.
  Without site isolation — the headless shell's default — the same frame stayed
  in the page's frame tree and reported `Page.frameNavigated` with a `parentId`.
  The navigation policy handles both, because the image runs a browser that has
  site isolation on and the test suite runs one that does not.
- **`Page.frameStoppedLoading` for the top frame follows `loadEventFired`**, by
  about a millisecond, which is what makes it safe to treat as a second way to
  decide a page has settled rather than an earlier one.

The driver itself is exercised against a real Chromium by
`packages/core/src/browser/cdpBrowser.integration.test.ts`, which skips itself
with a sentence where there is no browser to drive.
