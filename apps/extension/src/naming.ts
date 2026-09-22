/**
 * What this browser calls itself in Artemis settings.
 *
 * "Chrome on Windows". The user may have two browsers paired — a Chrome they
 * are signed into work with and a Brave they are not — and the list in settings
 * is where they revoke one, so the name has to be the one they would use for it
 * out loud. It is display text and nothing is decided from it.
 *
 * `navigator.userAgentData.brands` is the Chromium-family answer and is what
 * this reads. It is deliberately noisy: Chrome reports three brands, one of
 * which is a deliberately absurd `Not(A:Brand` entry designed to break exactly
 * the kind of code below, and Edge and Brave report themselves *plus*
 * "Chromium" and "Google Chrome". So the rule is to take the first brand that
 * is neither the decoy nor a generic, and fall back through the generics rather
 * than to the first entry, which is frequently the decoy.
 *
 * The user-agent string is the fallback for a browser without the hints. It is
 * read in the order the imposters demand — Edge and Brave both contain
 * "Chrome", so Chrome is only concluded when nothing more specific matched.
 */

/** What `navigator.userAgentData` offers, and what the fallback reads. */
export interface BrowserHints {
  readonly brands?: readonly { readonly brand: string }[] | undefined;
  readonly platform?: string | undefined;
  readonly userAgent?: string | undefined;
}

/** Brands that name no product: Chrome's decoy and the engine everyone shares. */
const GENERIC_BRANDS = [/not.?a.?brand/iu, /^chromium$/iu];

const PLATFORM_NAMES: readonly (readonly [RegExp, string])[] = [
  [/^windows$/iu, 'Windows'],
  [/^mac ?os|^macintosh|^darwin/iu, 'macOS'],
  [/^linux|^x11|^cros|^chrome ?os/iu, 'Linux'],
  [/^android/iu, 'Android'],
  [/^ios|^iphone|^ipad/iu, 'iOS'],
];

function productFromBrands(brands: readonly { readonly brand: string }[]): string | null {
  const named = brands.map((entry) => entry.brand).filter((brand) => !GENERIC_BRANDS.some((pattern) => pattern.test(brand)));
  const specific = named.find((brand) => !/^google chrome$/iu.test(brand));
  return specific ?? named[0] ?? null;
}

function productFromUserAgent(userAgent: string): string {
  if (/\bEdg\//u.test(userAgent)) return 'Microsoft Edge';
  if (/\bOPR\//u.test(userAgent)) return 'Opera';
  if (/\bBrave\//u.test(userAgent)) return 'Brave';
  if (/\bVivaldi\//u.test(userAgent)) return 'Vivaldi';
  if (/\bChrome\//u.test(userAgent)) return 'Chrome';
  return 'Browser';
}

function platformName(hints: BrowserHints): string | null {
  const declared = hints.platform ?? '';
  for (const [pattern, name] of PLATFORM_NAMES) if (pattern.test(declared)) return name;
  const userAgent = hints.userAgent ?? '';
  if (/Windows/u.test(userAgent)) return 'Windows';
  if (/Mac OS X|Macintosh/u.test(userAgent)) return 'macOS';
  if (/CrOS/u.test(userAgent)) return 'Linux';
  if (/Android/u.test(userAgent)) return 'Android';
  if (/iPhone|iPad/u.test(userAgent)) return 'iOS';
  if (/Linux|X11/u.test(userAgent)) return 'Linux';
  return null;
}

/** "Chrome on Windows", or just the product when the platform is unreadable. */
export function browserNameFrom(hints: BrowserHints): string {
  const brandName = hints.brands === undefined ? null : productFromBrands(hints.brands);
  const product = brandName ?? productFromUserAgent(hints.userAgent ?? '');
  const platform = platformName(hints);
  return platform === null ? product : `${product} on ${platform}`;
}

/** The running browser's name, read from the globals this file is about. */
export function thisBrowserName(): string {
  const data = navigator.userAgentData;
  return browserNameFrom({
    brands: data?.brands,
    platform: data?.platform,
    userAgent: navigator.userAgent,
  });
}
