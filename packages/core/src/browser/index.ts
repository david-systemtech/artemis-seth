/**
 * The browser tools, and nothing that knows what a browser is made of.
 *
 * `PageDriver` — the contract these tools are written against — lives in
 * `@rx-artemis/protocol`, because the Artemis extension implements the far end
 * of it and may import nothing that assumes Node. What lives here is the layer
 * above it: the six verbs a person could perform on a page, the five a
 * developer opens DevTools for, and the wording that tells a model whose
 * browser it is driving.
 *
 * No driver is implemented in core, deliberately. The embedded one needs
 * Electron, which core may never import; the server's needs a CDP socket; the
 * extension's runs inside Chrome. Core holds the part all three share.
 */

export * from './pageTools.js';
