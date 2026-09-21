/**
 * Proving the pairing secret without sending it.
 * ============================================================================
 *
 * Artemis sends a nonce; the extension answers with `HMAC-SHA256(secret,
 * nonce)` in hex. The secret itself crosses the wire once, in the answer to the
 * pairing code, and never again — so a process that can open the loopback port
 * and read the traffic afterwards still cannot drive the browser, and one that
 * can read the extension's storage already owns the browser and does not need
 * to.
 *
 * ## The encodings are the contract, and they were not written down
 *
 * `BridgeProof` in `@rx-artemis/protocol` said "`HMAC-SHA256(secret, nonce)`,
 * hex" and nothing about how a hex secret becomes key bytes. Two reasonable
 * implementations — key from the decoded bytes, key from the hex string's
 * characters — produce different macs and would have met as a silent refusal
 * the first time the desktop side was written. That doc comment now states the
 * encodings; this file is the half of the pair that exists.
 *
 * The decision is the conventional one: a hex secret denotes bytes, so the key
 * is those bytes. {@link secretKeyBytes} falls back to the string's UTF-8 bytes
 * when the secret is not hex at all, which is not an alternative encoding on
 * offer — it is so that a malformed secret from some future Artemis produces a
 * refusal from Artemis, which the user can read, rather than an exception in a
 * service worker, which nobody sees.
 */

/**
 * The HMAC key a stored secret denotes.
 *
 * Exported for the test, which is the only way to tell the two readings apart
 * without a second implementation to compare against.
 */
export function secretKeyBytes(secret: string): Uint8Array {
  if (secret.length > 0 && secret.length % 2 === 0 && /^[0-9a-f]+$/iu.test(secret)) {
    const bytes = new Uint8Array(secret.length / 2);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(secret.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  return new TextEncoder().encode(secret);
}

/** Lowercase hex, which is what the wire says and what Node's `digest('hex')` produces. */
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The answer to one challenge.
 *
 * `subtle` is a parameter so the unit test can run this under Node's WebCrypto
 * without a browser, and so the service worker's `crypto.subtle` is reached for
 * exactly once, here.
 */
export async function proveNonce(secret: string, nonce: string, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  const key = await subtle.importKey('raw', secretKeyBytes(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await subtle.sign('HMAC', key, new TextEncoder().encode(nonce) as BufferSource));
}
