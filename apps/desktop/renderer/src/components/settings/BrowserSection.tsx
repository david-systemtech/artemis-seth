/**
 * The Browser pane — pairing a Chrome, and what the agent may do in it.
 * ============================================================================
 *
 * *Which* browser a conversation uses is a permission question and is chosen
 * in Permissions & access, beside the permission modes. This pane is the other
 * half: the machinery behind the one option that needs setting up, and the
 * rules that apply once it is.
 *
 * Four things, in the order somebody meets them:
 *
 *  1. **Get the extension.** Chrome will not install an unpacked extension
 *     from outside Chrome, on any platform Artemis ships to, so this is four
 *     steps a person performs and a button that saves them the download. The
 *     steps are written out rather than linked, because the user is about to
 *     be in `chrome://extensions` where there is nothing to link from.
 *  2. **Pair.** Artemis shows a code; they type it into the extension. The
 *     countdown is computed here from `pairing.expiresAt` rather than pushed
 *     per second — a timestamp stays right across a push that arrives late,
 *     and "270 seconds left" does not.
 *  3. **The browsers that are paired**, with whether each is connected and a
 *     way to unpair. Unpairing cuts a live connection, so a run's next tool
 *     call refuses; that is issue #436's last acceptance criterion and the
 *     copy says it out loud.
 *  4. **What the agent may read.** The policy: dev sites, the block list, and
 *     the two switches that widen the first rule to every site.
 *
 * ## The block list is shown, not hidden behind the additions
 *
 * `DEFAULT_BLOCKED_SITES` is thirty-odd hosts and it is the single most
 * surprising thing about this feature: an agent that refuses to open the
 * user's bank looks broken unless they have seen the list. So it is drawn in
 * full, read-only, with a per-entry switch that moves the entry onto
 * `unblockedSites` — which is the only way to take one off, deliberately. A
 * text field where someone types `*.chase.com` to *unblock* it would be a
 * field where a typo silently does nothing.
 *
 * ## Saving is immediate, like every other pane in this dialog
 *
 * There is no Save button. Each control writes through on change, main
 * persists it and pushes it to every connected browser, and the state comes
 * back on the same channel. A pane with a Save button would be a pane where
 * closing the dialog quietly discards a policy the user thought they had set.
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { GlobeIcon } from 'lucide-react';

import {
  DEFAULT_BLOCKED_SITES,
  extensionIsOutdated,
  type ExtensionBridgeState,
  type PagePolicy,
  type PairedBrowserInfo,
} from '@rx-artemis/protocol';

import { call, resolveBridge } from '../../lib/bridge';
import { useApp } from '../../state/store';
import { SettingsGroup, SettingsPane } from './pane';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

/** The four steps, written out because the user is about to leave this window. */
const LOAD_STEPS: readonly string[] = [
  'Unzip the file you just saved.',
  'Open chrome://extensions in Chrome.',
  'Turn on Developer mode, top right.',
  'Click “Load unpacked” and choose the unzipped folder.',
];

export function BrowserSection(): ReactElement {
  const state = useApp((s) => s.extensionBridge);

  return (
    <SettingsPane
      title="Browser"
      description="Pair your Chrome with Artemis, and decide what an agent may do in it."
    >
      <GetTheExtension state={state} />
      <PairingGroup state={state} />
      <PairedBrowsers state={state} />
      <PolicyGroup policy={state?.policy ?? null} />
    </SettingsPane>
  );
}

/* -------------------------------------------------------------------------- */
/* The bridge's channels                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The bridge's channels, or `null` in a window with no bridge.
 *
 * A window served by another machine has them and they answer honestly: that
 * Artemis is not this one, so nothing is listening and nothing is paired. See
 * `remoteBridge.ts`.
 */
function channels(): ReturnType<typeof resolveBridge>['bridge'] extends null
  ? never
  : NonNullable<ReturnType<typeof resolveBridge>['bridge']>['extensionBridge'] | null {
  return resolveBridge().bridge?.extensionBridge ?? null;
}

/* -------------------------------------------------------------------------- */
/* Get the extension                                                          */
/* -------------------------------------------------------------------------- */

function GetTheExtension({ state }: { readonly state: ExtensionBridgeState | null }): ReactElement {
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const bundled = state?.bundledVersion ?? null;

  const save = async (): Promise<void> => {
    const surface = channels();
    if (surface === null) return;
    setProblem(null);
    const result = await call(() => surface.saveBundle({}));
    if (!result.ok) {
      setProblem(result.error.message);
      return;
    }
    // `null` is a cancel, which is not a failure and not worth a sentence.
    if (result.value.savedTo !== null) setSavedTo(result.value.savedTo);
  };

  return (
    <SettingsGroup label="Get the extension">
      <ItemGroup className="gap-0 divide-y divide-hairline">
        <Item size="sm" className="items-start">
          <ItemContent>
            <ItemTitle className="text-xs text-ink">The Artemis extension for Chrome</ItemTitle>
            <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
              {bundled === null
                ? 'This build of Artemis does not ship the extension. Download it from the release page for this version.'
                : `Version ${bundled}, shipped with this copy of Artemis. Save it somewhere, then load it into Chrome by hand — Chrome cannot be asked to install an unpacked extension from outside Chrome.`}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button size="sm" variant="secondary" disabled={bundled === null} onClick={() => void save()}>
              Save the extension…
            </Button>
          </ItemActions>
        </Item>
      </ItemGroup>

      <ol className="list-decimal space-y-1 px-3 py-2.5 pl-8 text-2xs leading-relaxed text-ink-faint">
        {LOAD_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      {savedTo === null ? null : (
        <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink">Saved to {savedTo}</p>
      )}
      {problem === null ? null : (
        <p className="px-3 py-2.5 text-2xs leading-relaxed text-amber">{problem}</p>
      )}
    </SettingsGroup>
  );
}

/* -------------------------------------------------------------------------- */
/* Pairing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The code, its countdown, and what the socket is doing.
 *
 * The countdown re-renders on a one-second tick held here, against the
 * absolute `expiresAt` main sent. Deliberately not a push per second: the
 * number is a subtraction the renderer can do, and pushing it would put an IPC
 * message on every second of every window for a code nobody may be looking at.
 */
function PairingGroup({ state }: { readonly state: ExtensionBridgeState | null }): ReactElement {
  const pairing = state?.pairing ?? null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (pairing === null) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [pairing]);

  const offer = (on: boolean): void => {
    const surface = channels();
    if (surface === null) return;
    void call(() => surface.pair({ offer: on }));
  };

  const left = pairing === null ? 0 : Math.max(0, Math.round((pairing.expiresAt - now) / 1000));

  return (
    <SettingsGroup label="Pair a browser">
      <ItemGroup className="gap-0 divide-y divide-hairline">
        <Item size="sm" className="items-start">
          <ItemContent>
            <ItemTitle className="text-xs text-ink">
              {pairing === null ? 'Not pairing' : 'Type this code into the extension'}
            </ItemTitle>
            <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
              {pairing === null ? (
                'Artemis shows a code; you type it into the Artemis extension in Chrome. It is good for five minutes and can be used once.'
              ) : (
                <>
                  <span className="font-mono text-sm tracking-[0.3em] text-ink">{pairing.code}</span>
                  <br />
                  {left > 0
                    ? `Good for another ${String(left)} seconds.`
                    : 'This code has expired. Show a new one.'}
                </>
              )}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button size="sm" variant={pairing === null ? 'secondary' : 'ghost'} onClick={() => offer(pairing === null)}>
              {pairing === null ? 'Show a code' : 'Stop'}
            </Button>
          </ItemActions>
        </Item>
      </ItemGroup>

      <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink-faint">
        <ListeningLine state={state} />
      </p>
    </SettingsGroup>
  );
}

/**
 * What the socket is doing, in one sentence per state.
 *
 * A taken port is said plainly and is not routed around: the extension dials a
 * fixed address, so an Artemis that quietly moved to another port would be one
 * no browser could find, with no symptom at all beyond a pairing that never
 * completes.
 */
function ListeningLine({ state }: { readonly state: ExtensionBridgeState | null }): ReactElement {
  if (state === null) return <>Asking Artemis what is listening…</>;
  const listening = state.listening;
  switch (listening.kind) {
    case 'listening':
      return <>Listening on 127.0.0.1 port {listening.port}, on this machine only.</>;
    case 'port-in-use':
      return (
        <span className="text-amber">
          Port {listening.port} is being used by something else, so the extension cannot connect.
          Close whatever holds it and restart Artemis.
        </span>
      );
    case 'failed':
      return (
        <span className="text-amber">
          Artemis could not listen on port {listening.port}: {listening.message}
        </span>
      );
    case 'stopped':
      return <>Nothing is listening. Browsers pair with the Artemis running on their own machine.</>;
  }
}

/* -------------------------------------------------------------------------- */
/* Paired browsers                                                            */
/* -------------------------------------------------------------------------- */

function PairedBrowsers({ state }: { readonly state: ExtensionBridgeState | null }): ReactElement {
  const browsers = state?.browsers ?? [];
  const bundled = state?.bundledVersion ?? null;

  const unpair = (browserId: string): void => {
    const surface = channels();
    if (surface === null) return;
    void call(() => surface.unpair({ browserId }));
  };

  return (
    <SettingsGroup label="Paired browsers">
      {browsers.length === 0 ? (
        <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink-faint">
          No browser is paired. Until one is, conversations set to “My Chrome” are told the
          extension is not connected, and say so rather than browsing something else.
        </p>
      ) : (
        <ItemGroup className="gap-0 divide-y divide-hairline">
          {browsers.map((browser) => (
            <PairedBrowserRow
              key={browser.browserId}
              browser={browser}
              bundled={bundled}
              onUnpair={() => {
                unpair(browser.browserId);
              }}
            />
          ))}
        </ItemGroup>
      )}
    </SettingsGroup>
  );
}

function PairedBrowserRow({
  browser,
  bundled,
  onUnpair,
}: {
  readonly browser: PairedBrowserInfo;
  readonly bundled: string | null;
  readonly onUnpair: () => void;
}): ReactElement {
  const outdated = extensionIsOutdated(browser.extensionVersion, bundled);
  return (
    <Item size="sm" className="items-start">
      <ItemContent>
        <ItemTitle className="text-xs text-ink">{browser.browserName}</ItemTitle>
        <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
          {browser.connected ? 'Connected. ' : 'Not connected — open Chrome to reach it. '}
          Paired {new Date(browser.pairedAt).toLocaleDateString()}.
          {outdated ? (
            <>
              {' '}
              <span className="text-amber">
                Update the extension: this browser is running {browser.extensionVersion} and Artemis
                ships {bundled}. An unpacked extension does not update itself.
              </span>
            </>
          ) : null}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button size="sm" variant="ghost" onClick={onUnpair}>
          Unpair
        </Button>
      </ItemActions>
    </Item>
  );
}

/* -------------------------------------------------------------------------- */
/* The policy                                                                 */
/* -------------------------------------------------------------------------- */

function PolicyGroup({ policy }: { readonly policy: PagePolicy | null }): ReactElement | null {
  if (policy === null) return null;

  const save = (next: PagePolicy): void => {
    const surface = channels();
    if (surface === null) return;
    void call(() => surface.policy({ policy: next }));
  };

  return (
    <>
      <SettingsGroup label="What the agent may read">
        <HostListField
          id="settings-browser-dev-sites"
          label="Sites you are developing"
          description={
            'Full access on these: request and response bodies, cookie values, local and session ' +
            'storage, and JavaScript the agent writes. Loopback and private addresses count ' +
            'without being listed. One host pattern per line — localhost, *.test, ' +
            'staging.example.com.'
          }
          hosts={policy.devSites}
          onChange={(devSites) => {
            save({ ...policy, devSites });
          }}
        />

        <ItemGroup className="gap-0 divide-y divide-hairline">
          <Item size="sm" className="items-start">
            <ItemContent>
              <ItemTitle className="text-xs text-ink">Run JavaScript on every site</ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                An agent can then run code it wrote on any page, not just the ones above. A page
                that tries to steer the agent is asking it to run that code as you.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                id="settings-browser-evaluate-everywhere"
                aria-label="Run JavaScript on every site"
                checked={policy.evaluateEverywhere}
                onCheckedChange={(on) => {
                  save({ ...policy, evaluateEverywhere: on });
                }}
              />
            </ItemActions>
          </Item>

          <Item size="sm" className="items-start">
            <ItemContent>
              <ItemTitle className="text-xs text-ink">
                Read cookies and storage on every site
              </ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                Cookie values, stored tokens and response bodies become readable everywhere. On a
                site you are signed in to, the session cookie is the login.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                id="settings-browser-deep-read-everywhere"
                aria-label="Read cookies and storage on every site"
                checked={policy.deepReadEverywhere}
                onCheckedChange={(on) => {
                  save({ ...policy, deepReadEverywhere: on });
                }}
              />
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsGroup>

      <SettingsGroup label="Sites the agent will not open">
        <HostListField
          id="settings-browser-blocked-sites"
          label="Blocked, on top of the list below"
          description="One host pattern per line. The agent is refused outright and told not to look for another route."
          hosts={policy.blockedSites}
          onChange={(blockedSites) => {
            save({ ...policy, blockedSites });
          }}
        />

        <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink-faint">
          Artemis blocks these by default — passwords, payments and banks. It is not a claim to
          completeness; it is the places where one wrong click costs money or every other password.
          Allow one and the agent may open it like anywhere else.
        </p>

        <ItemGroup className="gap-0 divide-y divide-hairline">
          {DEFAULT_BLOCKED_SITES.map((host) => {
            const allowed = policy.unblockedSites.includes(host);
            return (
              <Item key={host} size="sm">
                <ItemContent>
                  <ItemTitle className="font-mono text-2xs text-ink">{host}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label={`Allow ${host}`}
                    checked={allowed}
                    onCheckedChange={(on) => {
                      save({
                        ...policy,
                        unblockedSites: on
                          ? [...policy.unblockedSites, host]
                          : policy.unblockedSites.filter((one) => one !== host),
                      });
                    }}
                  />
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      </SettingsGroup>
    </>
  );
}

/**
 * A host-pattern list, edited as lines of text.
 *
 * A textarea rather than a chip editor with an add button, on the argument the
 * tool-policy fields in Permissions & access make: these are lists somebody
 * pastes and prunes a couple of times a year, and a per-entry control would be
 * more machinery than the task has.
 *
 * Committed on blur rather than on every keystroke. Each save is an IPC call
 * that main writes to disk and pushes to every connected browser, and doing
 * that per character would have a browser receive a policy for `*.exam` on the
 * way to `*.example.com`.
 */
function HostListField({
  id,
  label,
  description,
  hosts,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly hosts: readonly string[];
  readonly onChange: (hosts: readonly string[]) => void;
}): ReactElement {
  const [draft, setDraft] = useState(() => hosts.join('\n'));

  // Follow the stored value when it changes underneath — a second window
  // editing the same policy, or main answering with what it actually kept.
  useEffect(() => {
    setDraft(hosts.join('\n'));
  }, [hosts]);

  return (
    <Field className="px-3 py-2.5">
      <FieldLabel htmlFor={id} className="text-xs text-ink">
        {label}
      </FieldLabel>
      <Textarea
        id={id}
        value={draft}
        rows={3}
        spellCheck={false}
        className="font-mono text-2xs"
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={() => {
          onChange(
            draft
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0),
          );
        }}
      />
      <FieldDescription className="text-2xs leading-relaxed text-ink-faint">
        {description}
      </FieldDescription>
    </Field>
  );
}

/** The nav icon, exported beside the pane so the registry imports one thing. */
export const BROWSER_SECTION_ICON = GlobeIcon;
