/**
 * The browser tools, and the one driver core is allowed to implement.
 *
 * `PageDriver` — the contract these tools are written against — lives in
 * `@rx-artemis/protocol`, because the Artemis extension implements the far end
 * of it and may import nothing that assumes Node. What lives here is the layer
 * above it: the six verbs a person could perform on a page, the five a
 * developer opens DevTools for, and the wording that tells a model whose
 * browser it is driving.
 *
 * Two of the three drivers are not implemented here, and cannot be: the
 * embedded one needs Electron, which core may never import, and the
 * extension's runs inside Chrome. The third is: the headless Chromium beside an
 * Artemis Server is reached over a WebSocket and a JSON protocol, which is Node
 * and nothing else, and the server that drives it is this package's own.
 */

export * from './pageTools.js';
export * from './cdp.js';
export * from './cdpPage.js';
export * from './cdpPageDriver.js';
export * from './serverBrowser.js';
export * from './serverBrowserPolicy.js';
export * from './servedBrowser.js';
