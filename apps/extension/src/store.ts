/**
 * `chrome.storage`, with the two things every read of it needs.
 *
 * The first is a default: a key that has never been written comes back as an
 * absent property, and forty `?? fallback` at the call sites is forty places to
 * forget one. The second is distrust: storage survives upgrades, so a value
 * written by an older version of this extension — or by a `chrome.storage.set`
 * from a devtools console — is not necessarily the shape this version expects.
 * Every read is therefore shaped by the caller's own validator, and a value
 * that fails it is treated as absent rather than as a crash on start.
 */

/** Read one key, shaped and defaulted. */
export async function readLocal<T>(key: string, shape: (value: unknown) => T | null, fallback: T): Promise<T> {
  return read(chrome.storage.local, key, shape, fallback);
}

export async function writeLocal(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function dropLocal(key: string): Promise<void> {
  await chrome.storage.local.remove(key);
}

export async function readSession<T>(key: string, shape: (value: unknown) => T | null, fallback: T): Promise<T> {
  return read(chrome.storage.session, key, shape, fallback);
}

export async function writeSession(key: string, value: unknown): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}

async function read<T>(
  area: { get(keys: string): Promise<Record<string, unknown>> },
  key: string,
  shape: (value: unknown) => T | null,
  fallback: T,
): Promise<T> {
  try {
    const bag = await area.get(key);
    const shaped = shape(bag[key]);
    return shaped ?? fallback;
  } catch {
    // A storage area that will not answer is a browser in trouble; the
    // extension's job then is to behave as an unpaired one rather than to
    // throw out of the service worker's start-up and take the socket with it.
    return fallback;
  }
}

/** A shaper for a plain object, which is what every value here is. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A shaper for a whole number in a range — the port, and nothing else so far. */
export function asPort(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : null;
}
