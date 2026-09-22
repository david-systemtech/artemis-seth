# A headless Chromium for an Artemis Server to drive.
#
# Built here rather than pulled from a third party, so that a security update to
# Chromium is `docker compose build browser` and not a wait for somebody else's
# tag to move. This browser reads the open web on an agent's instruction, which
# makes it the container in this stack most worth keeping patched. It is also
# the smaller supply-chain surface: Debian's own package, signed by Debian,
# against an image that is already in the stack.
#
# The open question in the design doc — Playwright's pinned Chromium build or
# Debian's? — is answered here in favour of Debian's, on exactly that reasoning.
# What is given up is a pinned revision: an apt upgrade can change the browser's
# behaviour between two builds. That is the right way round for a browser whose
# job is to load whatever a developer's app and the public internet hand it.
#
# Nothing in this image is Artemis. The server reaches it over the DevTools
# protocol and nothing else, so a compromised page has a Chromium and a network
# with one server on it, and no Artemis credentials at all.
#
# UNTESTED IN THIS FORM. It could not be built or run where it was written
# (there is no Docker there), so the CDP behaviour below was measured against a
# headless Chromium started by hand and the *packaging* is reasoned rather than
# proved. See docs/SERVER-BROWSER.md, "What has not been run".

FROM debian:bookworm-slim

# `chromium` is the full browser; `--headless=new` is how it runs without a
# display. Preferred over `chromium-headless-shell`-style builds for one
# measured reason: Playwright's headless shell (Chromium 141) **ignores**
# `--remote-debugging-address` and binds the DevTools port to loopback whatever
# it is given, which in a container means nothing can reach it. The full
# browser honours the switch. If a future Debian build stops honouring it, the
# fix is a relay rather than a different browser — run the browser on
# 127.0.0.1:9223 and put `socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223`
# in front of it; a relay was measured to preserve everything the server needs,
# including the Host header Chromium echoes back into `webSocketDebuggerUrl`.
#
# `fonts-liberation` is not decoration: a Chromium with no fonts renders every
# screenshot as boxes, which is a bug report an agent would file against the
# application under test.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       chromium \
       ca-certificates \
       fonts-liberation \
       curl \
  && rm -rf /var/lib/apt/lists/*

# Not root. A browser is the process in any stack most likely to be running
# somebody else's code, and this one is pointed at the open web by an agent.
# The home directory is where Chromium writes its profile, so it has to be
# writable and it has to be the user's own.
RUN useradd --create-home --shell /usr/sbin/nologin browser
USER browser
WORKDIR /home/browser

EXPOSE 9222

# The flags, each of which is load-bearing in a container:
#
#   --headless=new              no display, and the modern implementation.
#   --remote-debugging-address  bind the DevTools port to the container's
#     =0.0.0.0                  interface. Without it the port is on loopback
#                               and the server cannot reach it. Safe here only
#                               because the compose file publishes no port and
#                               puts the browser on a network with one other
#                               container on it: the DevTools port is a total
#                               authority over this browser and has no auth of
#                               its own.
#   --remote-debugging-port     where. Matches ARTEMIS_BROWSER_CDP_URL.
#   --no-sandbox                Chromium's own sandbox needs privileges a
#                               hardened container does not give it. The
#                               container is the sandbox instead, which is why
#                               it holds nothing but a browser.
#   --disable-dev-shm-usage     Docker's default /dev/shm is 64 MB and Chromium
#                               puts renderer shared memory there; without this
#                               a real page kills the tab with no message worth
#                               reading. The alternative is `shm_size: 1gb` in
#                               the compose file, which spends the memory the
#                               limit was set to bound.
#   --disable-gpu               there is no GPU and probing for one is slow.
#   --disable-background-networking, --no-first-run, --no-default-browser-check
#                               a browser nobody will ever look at does not
#                               need a first-run flow or an update ping.
#   --disable-features=Translate,MediaRouter
#                               two subsystems that start work for a user who
#                               is not there.
#
# No --remote-allow-origins: measured on Chromium 141, a Node client connecting
# with the platform WebSocket sends no Origin header, so there is nothing for it
# to allow. Adding it would widen what a hostile page could do if one ever
# reached this port.
CMD ["chromium", \
     "--headless=new", \
     "--remote-debugging-address=0.0.0.0", \
     "--remote-debugging-port=9222", \
     "--no-sandbox", \
     "--disable-dev-shm-usage", \
     "--disable-gpu", \
     "--disable-background-networking", \
     "--no-first-run", \
     "--no-default-browser-check", \
     "--disable-features=Translate,MediaRouter", \
     "about:blank"]

# Loopback and not the service name, deliberately: Chromium refuses a DevTools
# HTTP request whose Host header is a name rather than an IP or `localhost`,
# and a health check that asked by name would fail against a perfectly healthy
# browser. The server has the same problem and solves it by resolving the name
# to an address first — see `resolveCdpEndpoint` in core.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS http://127.0.0.1:9222/json/version || exit 1
