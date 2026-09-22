# The Artemis browser extension

An MV3 extension that lets an Artemis conversation drive **the browser you are
already signed into**. Chrome, Edge, Brave — anything Chromium-family.

Artemis has three browsers it can drive. The one in the desktop's dock is its
own session, so every site has to be signed into again. The one beside an
Artemis Server is signed into nothing, which is what you want for testing what
an agent built. This is the third: your Chrome, your logins, which is both the
point of it and the danger in it. Issue #436 is the decision record.

Any conversation can use it — Claude, Codex, a local model, running here or on a
server — because it implements `PageDriver` from `@rx-artemis/protocol`, which
is the one contract all three browsers answer to.

**A conversation running on an Artemis Server can use it too, and the extension
knows nothing about that.** The agent on the server sends a verb; the server
publishes it to the one connection the run came in on; the Artemis desktop at
that end performs it through this extension and posts the answer back. Nothing
tunnel-related reaches here — this extension still only ever dials the Artemis
on its own machine — and a server's operator can turn the whole arrangement off
with `ARTEMIS_ALLOW_CLIENT_BROWSER=0`, in which case the conversation is told so
in as many words. See `packages/core/src/server/browserRelay.ts` and
`packages/core/src/adapters/artemis/browserClient.ts`.

---

## The security model, in plain words

The thing being protected is a browser full of live sessions. The adversaries
are a web page the agent reads, a compromised Artemis, and this extension's own
supply chain.

**It only ever dials out, to this machine.** The extension connects *to*
Artemis, at `ws://127.0.0.1:<port>`. It never listens, and there is no host
setting — only a port. The address is built in one function
(`src/bridge/address.ts`), checked again immediately before the socket is
opened, and the manifest's `connect-src` says the same thing a third time in a
place this extension's own code cannot reach.

**Pairing, once.** Artemis shows a code; you type it on the options page. Artemis
answers with a browser id and a secret, and the code is spent. Every later
connection proves the secret without sending it: Artemis sends a nonce, the
extension answers with `HMAC-SHA256(secret, nonce)`. Another process that can
open the port cannot drive your browser; one that can read the extension's
storage already owns your browser and did not need to.

Artemis, for its part, accepts a connection only from *this* extension's origin
— the id the manifest's `key` fixes — rather than from any extension you happen
to have installed.

**The policy is enforced here, in the browser.** Artemis sends a `PagePolicy`
and this extension decides — on every verb, against the address the tab
*actually* has. A compromised Artemis cannot talk its way past it, because it is
not being asked.

- Password managers, payment sites and banks are not opened at all. The list is
  `DEFAULT_BLOCKED_SITES` in the protocol; you can take entries off it, and add
  your own, in Artemis settings.
- **After every load and before every verb, the tab's real address is read
  again.** A redirect, a link the agent clicked, or `window.location` set by a
  script on a page the agent is reading can put a tab somewhere it may not be.
  A tab found there is sent to `about:blank` and the verb is refused.
- On sites you are developing — this machine's own addresses, private networks,
  and whatever you list in Artemis settings → dev sites — the agent gets cookie
  values, local and session storage, and `evaluate`. Everywhere else it gets
  cookie *names* and attributes without values, no storage, and no arbitrary
  JavaScript. On a site you are signed into, the session cookie is the login.
- `chrome://`, `chrome-extension://`, `file://`, devtools pages and the Chrome
  Web Store are never reachable, by any setting.

**It cannot see your other tabs.** One tab per conversation, all of them in a
tab group titled **Artemis**. The extension learns a tab id exactly one way — by
`chrome.tabs.create` returning one — and there is no `tabs` permission and no
`chrome.tabs.query` anywhere in the package. It is not that it does not look;
it is that it has nothing to look with.

**It is visible and stoppable.** The tab group is the mark, and Chrome's own
"Artemis is debugging this browser" bar sits on every driven tab. The toolbar
button shows what is connected and which conversations have pages open, and
**Stop Artemis** closes every Artemis tab, detaches the debugger from all of
them, disconnects, and does not come back until you say so.

**There is a log.** The last thousand actions — time, conversation, verb, host,
and the reason for anything refused — on the options page. It is local, it is
never sent anywhere, and it records the host rather than the whole address so
that search terms and tokens in a URL do not end up in it.

**No remote code.** Everything is bundled at build time. The CSP is
`script-src 'self'; object-src 'none'`, and `connect-src` permits loopback and
nothing else — no page of this extension can fetch anything from the web.

---

## The permissions, one at a time

`manifest.json` is generated from `src/manifest.ts`, where each of these is
argued for at length. In short:

| Permission | Why it is there |
| --- | --- |
| `debugger` | Everything done to a page. Navigate, screenshot, click, type, the console, the network panel, cookies, storage, evaluate — all CDP 1.3, attached only to tabs this extension opened. It is the heaviest permission Chrome has and it is not avoidable: `chrome.scripting` cannot give you the console or the network panel, which is most of what debugging a site needs. Chrome's yellow "being debugged" bar is a feature here. |
| `tabGroups` | To title the group "Artemis" and colour it. Without it the group is an unnamed grey one indistinguishable from yours, and "the tab group is the mark" stops being true. |
| `storage` | The pairing secret, the port, the policy, the run-to-tab map, the audit log, and the console buffers. |
| `alarms` | An MV3 service worker is stopped when it goes quiet, and a stopped worker holds no socket. An alarm every thirty seconds is what brings it back to redial. `setTimeout` cannot: the timer dies with the worker that set it. |

And what is **not** asked for, each of which was measured rather than assumed:

- **No `tabs`.** It reads as "Read your browsing history" and would let this
  extension enumerate your open tabs. `tabs.create`, `tabs.group`,
  `tabs.remove` and `tabGroups.update` all work without it, and a tab's address
  and title come from `Target.getTargetInfo` on the debugger session this
  extension opened on its own tab.
- **No `host_permissions`.** A WebSocket to loopback needs none — WebSocket is
  not subject to CORS, and `chrome-extension://` is a secure context, so
  `ws://127.0.0.1` is not mixed content. Host permissions would read as "Read
  and change all your data on all websites" and buy nothing.
- **No content scripts.** Every page interaction is CDP. A content script would
  run in pages this extension has no business in.
- **No `cookies` permission.** It grants cookies for every site at once.
  `Network.getCookies` on the attached tab gives the cookies for the page the
  agent is on, which is the only set it should ever see.
- **No `identity`.** Several Chrome profiles can be paired with one Artemis,
  and each is named by hand at pairing — "Work", "Personal" — because Chrome
  offers no API for a profile's own display name. `identity` would allow
  `chrome.identity.getProfileUserInfo`, whose email could be offered as the
  field's default text instead of "Chrome on Windows", and that is the whole of
  what it would buy. It reads in the install prompt as knowing who you are
  signed in to Google as, which is a poor trade for a better first draft of a
  label the user is typing anyway. Worth revisiting if naming browsers turns
  out to be the step people get wrong.

---

## Building it

```bash
pnpm install
pnpm run build:extension     # from the repository root
```

That writes `apps/extension/dist/`: `manifest.json`, `worker.js`,
`options.html` / `options.js`, `popup.html` / `popup.js`, `ui.css` and four
icons. Nothing is minified — an extension that asks for the `debugger`
permission should be readable by whoever is deciding whether to trust it.

The version is read from `apps/desktop/package.json` at build time, so the
extension's version and the app's mean the same thing. An extension loaded
unpacked does not update itself, and that is how Artemis can tell you when the
one in your browser is older than the app.

The icons are generated by the build (`build.ts`) rather than checked in: a
purple disc with a white ring and crosshair, drawn pixel by pixel and encoded as
PNG. A binary in a repository is a thing nobody can review or diff, and four
sizes of it are four such things. If Artemis ever gets a real mark, that
function is replaced by reading it.

### The extension's id is fixed

`pbdboognedfpknmikiajchompjfjhdal`, on every machine, because `manifest.json`
carries a `key`. Without one Chrome derives an id from the install path, so an
unpacked extension has a different id on every machine and Artemis has no stable
name for "the extension".

Only the **public** half of the key pair is committed. It was made once with

```bash
openssl genrsa 2048 > artemis-extension.pem
openssl rsa -in artemis-extension.pem -pubout -outform DER | base64 -w0
```

and the private half was not kept: nothing in this repository signs a `.crx`,
and a private key in a public repository is a key anyone can impersonate the
extension with. If a Chrome Web Store listing happens later, the Store issues
its own key and that value replaces this one.

## Loading it unpacked

1. `chrome://extensions`
2. Turn on **Developer mode** (top right).
3. **Load unpacked**, and choose `apps/extension/dist`.
4. Open Artemis → Settings, find the pairing code, and click **Details → Extension
   options** on the extension (or the Artemis toolbar button → Options).
5. Type the port Artemis is listening on if it is not the default `47615`, then
   the pairing code.

The status on that page is the whole truth about the connection: *not paired*,
*connecting*, *connected to Artemis*, *refused* with Artemis's own words, or
*stopped*.

Edge and Brave are the same steps at `edge://extensions` and `brave://extensions`.

## Running the tests

```bash
pnpm --filter @rx-artemis/extension test
```

The unit tests cover the parts worth being sure about on their own: the
handshake and the proof, the policy decision for each verb, cookie redaction,
the bounded buffers, the reconnect backoff, the run-to-tab bookkeeping, and the
manifest itself.

The end-to-end test builds this package into a temporary directory, loads *that*
into a headless Chromium, pairs it with a fake Artemis by typing a code into the
real options page, and then exercises every verb from the Artemis side — plus
the policy on three kinds of host, a redirect onto a blocked site, a proof that
is refused, and the stop button. It needs a Chromium:

```bash
pnpm dlx playwright install chromium     # once
pnpm --filter @rx-artemis/extension test
```

Without one it is skipped with a message saying so. It is also skipped on CI
unless `ARTEMIS_E2E_CHROME` names a browser explicitly — GitHub's Ubuntu runners
ship Google Chrome, and "run if you find a browser" would quietly turn this into
a CI suite on a browser nobody pinned. `test/chromium.ts` has the argument.

Nothing in that suite leaves the machine. The three hosts it uses —
`127.0.0.1`, `shop.example` and `www.paypal.com` — are one loopback HTTP server
reached under three names through Chrome's `--host-resolver-rules`, which is how
a blocked bank and a public-looking site can both be exercised without a packet
going anywhere.

There is a second end-to-end suite on the other side of the wire,
`apps/desktop/main/extensionBridge.e2e.test.ts`, run with

```bash
cd apps/desktop && NODE_ENV=test pnpm exec vitest run main/extensionBridge.e2e.test.ts
```

It drives *this* extension from the real Artemis bridge rather than from a fake
one — the only place the mac is computed here and verified there — and then does
the same thing again through a real Artemis Server, to prove the served path
end to end. Same skip rule, for the same reasons.

### What those suites do not prove

- **No human has looked at any of this.** The machines it was built on have no
  display. The browser was real and headless; the pane in Artemis that pairs
  with it, the picker that chooses it and every word of their copy exist only as
  assertions.
- **The served suite stands one thing in.** A fake run source drives the relayed
  driver where an agent would. What that skips is `/v1/chat/completions`
  deciding whether a run may have a browser at all, which has its own tests in
  `packages/core/src/server/__tests__/completions.test.ts`.
- **A desktop *serving* other people does not relay.** It declines
  `artemis.extensionBrowser` and says so; `apps/desktop/main/server.ts` has the
  reason. The headless server does relay, and is what the suite above uses.
- **Nothing has been through GitHub Actions or a packaged build.** The release
  workflow's extension job and `extraResources` placing the zip inside the app
  are untested outside of reading them.

## Where things are

```
build.ts             the build: esbuild, the icons, the manifest
src/manifest.ts      the manifest, and the argument for every line of it
src/chrome.d.ts      the extension APIs this package may use, and no others
src/worker.ts        the service worker: one socket, one driver, the state between
src/bridge/          the wire: the address, the backoff, the proof, the handshake
src/page/            the verbs: the driver, the policy, the buffers, the tab book
src/ui/              the options page and the popup
test/                the fake Artemis, the test site, the browser, the e2e suite
```

## Known limits

- **The first click on a tab can take about five seconds.** These tabs are
  opened in the background and a background tab has no compositor frame, so
  Chrome cannot hit-test the click until it makes one. Every later click on the
  same tab is immediate. Bringing the tab to the front would avoid it and is the
  wrong trade — the agent would take your focus on every click.
- **The network log does not survive the service worker being stopped.** Console
  lines do: they are whole when they arrive and are written to
  `chrome.storage.session`. Half of a network entry is a request still in
  flight, keyed by a debugger session id that a new session will not reuse, so
  restoring it would produce entries that can never be completed.
- **Unpacked extensions do not update themselves**, and Chrome nags about
  developer mode at every start. An unlisted Chrome Web Store listing is the
  intended answer; see #436.
