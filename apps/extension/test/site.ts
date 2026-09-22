/**
 * The site the end-to-end test drives.
 * ============================================================================
 *
 * One HTTP server on loopback, serving every page the suite needs. It is
 * reached under three names, which is how the suite exercises the policy
 * without a packet leaving the machine:
 *
 *  - `127.0.0.1` — the machine's own address, so a dev site: cookie values,
 *    storage and `evaluate` are all allowed there.
 *  - `shop.example` — mapped to 127.0.0.1 by Chrome's `--host-resolver-rules`.
 *    A public-looking host that is not a dev site, so cookie values are
 *    withheld and `evaluate` is refused.
 *  - `www.paypal.com` — mapped the same way. On {@link DEFAULT_BLOCKED_SITES},
 *    so it may not be opened at all, and a redirect onto it must end at
 *    `about:blank`.
 *
 * The page itself is deliberately full of the things a developer opens DevTools
 * for: a console line, an uncaught exception, a request that fails, a cookie, a
 * form, and both kinds of storage.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Artemis test site</title></head>
  <body>
    <h1>Artemis test site</h1>
    <p id="prose">A page with a form, a console, an exception and a failing request.</p>
    <form id="form" onsubmit="return false">
      <input id="name" name="name" value="original value" />
      <textarea id="notes">original notes</textarea>
      <button id="log" type="button">Log</button>
      <button id="boom" type="button">Throw</button>
      <button id="go" type="button">Go elsewhere</button>
    </form>
    <p id="events">no events yet</p>
    <script>
      // Storage, for the storage verb. Written before anything can navigate
      // away, so the snapshot is deterministic.
      localStorage.setItem('cart', 'CJ-1');
      sessionStorage.setItem('step', 'checkout');

      // One console line and one request that fails, on every load.
      console.log('page ready', { cart: 'CJ-1' });
      fetch('/drop').catch(function () {});

      // An input listener, so the test can prove that typing fired events a
      // framework would be listening for rather than only setting a property.
      document.getElementById('name').addEventListener('input', function (event) {
        document.getElementById('events').textContent = 'input fired: ' + event.target.value;
      });

      document.getElementById('log').addEventListener('click', function () {
        console.log('the button was clicked');
        document.getElementById('events').textContent = 'the button was clicked';
      });

      document.getElementById('boom').addEventListener('click', function () {
        throw new Error('boom from the page');
      });

      document.getElementById('go').addEventListener('click', function () {
        window.location.href = '/elsewhere';
      });
    </script>
  </body>
</html>`;

const ELSEWHERE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Elsewhere</title></head>
<body><h1>Elsewhere</h1><p>The click went somewhere.</p></body></html>`;

export interface TestSite {
  readonly port: number;
  /** An address on this site under a given host name. */
  url(host: string, path?: string): string;
  close(): Promise<void>;
}

export async function startTestSite(): Promise<TestSite> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';

    // A socket closed mid-response, which Chrome reports as a failed request.
    // Deterministic in a way that dialling a closed port is not.
    if (path === '/drop') {
      request.socket.destroy();
      return;
    }

    if (path === '/redirect-to-blocked') {
      // A 302 onto a site the policy blocks: the case an address checked only
      // before the navigation would miss entirely.
      response.writeHead(302, { location: `http://www.paypal.com:${String(port(server))}/` });
      response.end();
      return;
    }

    if (path === '/elsewhere') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(ELSEWHERE);
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': 'sid=session-token-value; Path=/; HttpOnly; SameSite=Lax',
    });
    response.end(PAGE);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: port(server),
    url: (host, path = '/') => `http://${host}:${String(port(server))}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function port(server: Server): number {
  return (server.address() as AddressInfo).port;
}
