/**
 * The four expressions this extension runs in a page, and why they are these.
 * ============================================================================
 *
 * Every one of them is a fixed string with the caller's selector or text
 * inserted through `JSON.stringify`, which is the only way a value from the
 * model reaches a page anywhere in this package. `browserTools.ts` in the
 * desktop makes the same point: a selector is model output, it routinely
 * contains quotes (`[data-id="save"]`), and concatenating one into a script is
 * the injection this file would otherwise be full of.
 *
 * These are not subject to the `evaluate` policy gate, and the distinction is
 * worth stating plainly: the gate exists because *arbitrary* JavaScript from a
 * model makes every other rule decorative — a click could be spelled as a
 * `fetch`, a block list stepped around with `location.href`. These four are
 * fixed programs that do the thing their verb says and nothing else, on a page
 * the policy has already allowed. `read` and `click` are verbs a person could
 * perform; refusing them on a site the user has not listed as their own would
 * leave the extension unable to read a page, which is most of what it is for.
 */

/** A value from the model, as JavaScript source. Never string concatenation. */
function literal(value: string): string {
  return JSON.stringify(value);
}

/**
 * The page's readable text.
 *
 * `innerText` rather than `innerHTML`, for the reason the desktop's tools give:
 * markup is mostly attributes and framework noise, a page whose prose is two
 * kilobytes is routinely four hundred kilobytes of HTML, and `innerText`
 * honours `display: none` so it omits what the reader cannot see — which is the
 * same answer a screenshot gives.
 */
export const READ_SCRIPT = `(() => {
  const body = document.body;
  return { title: document.title, text: body ? body.innerText : '' };
})()`;

/**
 * Where an element is, after making it visible.
 *
 * `scrollIntoView` first, then measure: an element below the fold has a
 * rectangle outside the viewport, and dispatching a mouse event at coordinates
 * the compositor has nothing at hits whatever *is* there, which is the worst
 * possible outcome for a click. Measuring after the scroll is what makes the
 * coordinates mean the element.
 *
 * `inView` is reported rather than decided here so the driver can choose: a
 * rectangle of zero size (a hidden input, an element inside a collapsed parent)
 * has no coordinates worth dispatching at, and the driver falls back to
 * `.click()`, which a person could not do but which is what the agent meant.
 */
export function locateScript(selector: string): string {
  return `(() => {
  const el = document.querySelector(${literal(selector)});
  if (!el) return { found: false };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const inView = r.width > 0 && r.height > 0 &&
    r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, inView, tag: el.tagName };
})()`;
}

/** A click through the DOM, for an element with no rectangle to aim at. */
export function domClickScript(selector: string): string {
  return `(() => {
  const el = document.querySelector(${literal(selector)});
  if (!el) return { found: false };
  el.click();
  return { found: true };
})()`;
}

/**
 * Replace what is in a field, so that a framework notices.
 *
 * This is the one place in the package where the obvious implementation is
 * wrong, so the reasoning is written out.
 *
 * Setting `el.value` directly does change the field and does not change a React
 * app: React installs its own `value` setter on the element instance and reads
 * the last value it wrote, so a direct assignment is invisible to it and the
 * next render puts the old text back. The fix is the one React's own test
 * utilities use — call the *prototype's* native setter, which writes the field
 * the instance setter shadows, and then dispatch `input`, which is the event
 * React's `onChange` is actually bound to. `change` follows for everything
 * else: plain HTML, Vue, and validation that only runs on blur.
 *
 * Real keystrokes through `Input.dispatchKeyEvent` were the other candidate and
 * were rejected: replacing existing content with them needs a select-all first,
 * which means `el.select()` on an input, `document.execCommand('selectAll')` in
 * a contenteditable, and neither on a custom editor — three paths, each with
 * its own way to leave half the old text behind. Typing is meant to be
 * deterministic; clicking is where a real event matters, and `click` uses one.
 */
export function typeScript(selector: string, text: string): string {
  return `(() => {
  const el = document.querySelector(${literal(selector)});
  if (!el) return { found: false };
  const value = ${literal(text)};
  el.focus();
  if (el.isContentEditable) {
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: value, inputType: 'insertText' }));
    return { found: true, kind: 'contenteditable', value: el.textContent };
  }
  if (typeof el.value !== 'string') return { found: true, kind: 'not-a-field', tag: el.tagName };
  const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const native = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (native && native.set) native.set.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  return { found: true, kind: 'field', value: el.value };
})()`;
}

/**
 * Local and session storage for the page's origin.
 *
 * Both are read in one expression so the snapshot is of one moment. A page that
 * writes a token between two round trips would otherwise produce a `local` and
 * a `session` that never existed together.
 *
 * Bounded: a site that keeps its offline cache in `localStorage` has megabytes
 * there, and the whole of it would arrive as one tool result.
 */
export const STORAGE_SCRIPT = `(() => {
  const read = (store) => {
    const out = {};
    let budget = 64 * 1024;
    try {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key === null) continue;
        const value = store.getItem(key) ?? '';
        budget -= key.length + value.length;
        if (budget < 0) { out['…'] = 'truncated: this origin holds more than 64 KB here'; break; }
        out[key] = value;
      }
    } catch (error) { out['…'] = String(error); }
    return out;
  };
  return { origin: location.origin, local: read(localStorage), session: read(sessionStorage) };
})()`;
