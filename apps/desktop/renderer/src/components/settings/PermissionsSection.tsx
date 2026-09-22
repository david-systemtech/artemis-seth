/**
 * Permissions & access.
 * ============================================================================
 *
 * What the agent is allowed to do without asking first, whose browser it does
 * it in, and — for the parts Artemis cannot yet decide — an honest account of
 * who does decide.
 *
 * ---------------------------------------------------------------------------
 * THE MODE LIST COMES FROM THE PROVIDER, ALWAYS
 * ---------------------------------------------------------------------------
 *
 * `usePermissionModes()` reads the *active provider's* declared subset, not the
 * `PermissionMode` union. Providers accept different subsets, and a mode this
 * pane offered that the provider rejects would be a setting the user changed
 * and the run silently ignored. The copy below is keyed by mode so that adding
 * a mode to the protocol shows up here as a type error rather than as a blank
 * row — but the copy decides *wording*, never *membership*.
 *
 * The labels are longer than the status line's. That is deliberate rather than
 * an oversight: the status line renders these into a 20px segment where "ask"
 * and "bypass" are all that fit, and the same terseness in a settings pane
 * would leave the user to guess what "auto" means from four letters. Same
 * modes, two registers, and the one that has room spells it out.
 *
 * ---------------------------------------------------------------------------
 * WHOSE BROWSER IS A PERMISSION QUESTION, SO IT LIVES HERE
 * ---------------------------------------------------------------------------
 *
 * It had a pane of its own once, parked beside this one with a nav comment
 * arguing the adjacency — "a comfort question until it is a permission
 * question". The second half of that sentence won. The choice decides what the
 * agent may *reach*, which is the same species of question as the mode list
 * above, so it sits under it rather than one door over.
 *
 * It used to be two independent switches — "Browse with your Chrome" and "Open
 * pages in your default browser" — described here as "the same preference at
 * two strengths". Two switches were four combinations for three answers, with
 * one combination that meant nothing and a paragraph under each explaining
 * which won. Adding the Artemis extension would have made it three switches,
 * eight combinations and four answers, so it is now one picker of four:
 *
 *  - **Artemis's built-in browser** — the dock tab. Its own cookie jar, which
 *    is why it loses on the real web: sign-in flows reject embedded browsers
 *    outright and every permission prompt is refused.
 *  - **My Chrome (Artemis extension)** — the user's real browser, every
 *    provider, through a bridge Artemis owns. Disabled with a reason when no
 *    browser is paired or the paired one is not running; pairing lives in
 *    Settings → Browser.
 *  - **Claude in Chrome** — the same browser through Claude's own bridge.
 *    Claude conversations only, which is why it is disabled with a reason on
 *    every other provider, and only when the account is signed in rather than
 *    using an API key — a rule the CLI enforces and this pane only reports.
 *  - **Open in my browser** — one-way. Pages land in the default browser and
 *    the agent is told it cannot see them.
 *
 * The rules for which options can be offered are in `browserChoice.ts` and not
 * here, because the composer needs the same answer when it builds a run input:
 * an option this pane would have disabled must not be one a stored preference
 * silently keeps using.
 *
 * ---------------------------------------------------------------------------
 * THE TOOL LISTS ARE SHOWN, DISABLED, AND SAY WHY
 * ---------------------------------------------------------------------------
 *
 * `RunInput` carries `allowedTools` and `disallowedTools`, but nothing in the
 * renderer store holds them and no IPC call writes them — the fields exist in
 * the protocol and no UI fills them in. A textarea wired to nothing would take
 * a user's carefully written deny list and drop it on close, which is the worst
 * outcome available. So the controls are here, disabled, each carrying the
 * sentence that says what would have to exist for them to work. That is the
 * same rule every capability-gated control in this app follows, applied to a
 * gap in Artemis rather than a gap in the provider.
 *
 * `additionalDirectories` is no longer one of them. The working-directory pane
 * fills it in per session — folders picked there, plus the enabled team memory
 * banks the main process merges into every run — so this pane says where that
 * control lives instead of offering a second, disconnected copy of it. Two
 * editors for one field is how a setting gets lost.
 */

import type { ReactElement } from 'react';
import { ShieldIcon } from 'lucide-react';
import type { PermissionMode } from '@rx-artemis/protocol';

import { WithReason } from '../disabled-reason';
import { usePermissionModes } from '../../hooks/useCapability';
import { ChoiceList, SettingsGroup, SettingsPane, type Choice } from './pane';
import {
  activeProviderLabel,
  browserModeContext,
  setBrowserMode,
  setExtensionReach,
  setPermissionMode,
  useApp,
} from '../../state/store';
import { usePane } from '../../state/paneContext';
import {
  browserChoiceOf,
  browserChoiceValue,
  browserPickerOptions,
  type ExtensionReach,
} from '../../state/browserChoice';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

/**
 * The two ways a conversation can come by the paired Chrome.
 *
 * Per conversation is first because it is the default and stays it: driving a
 * browser full of somebody's live sessions is a larger grant than any other
 * option in this pane, and a default that made every conversation take it
 * would be a grant nobody opted into.
 */
const REACH_CHOICES: readonly Choice<ExtensionReach>[] = [
  {
    id: 'per-conversation',
    label: 'Each conversation chooses',
    note: 'A conversation uses your Chrome only after you pick it there. Everything else gets the built-in browser.',
  },
  {
    id: 'always-on',
    label: 'Always on',
    note: 'Every conversation uses your paired Chrome, unless it picks something else for itself.',
  },
];

/** Long-form names for the settings pane. See the file header on why these differ from the status line's. */
const MODE_LABELS: Record<PermissionMode, string> = {
  plan: 'Plan only',
  default: 'Ask before acting',
  acceptEdits: 'Accept edits, ask for the rest',
  auto: 'Let the provider decide',
  dontAsk: 'Never ask',
  bypassPermissions: 'Bypass all permission checks',
};

const MODE_NOTES: Record<PermissionMode, string> = {
  plan: 'Research and propose only. No file is written and no command runs, however the conversation goes.',
  default: 'Prompt for anything not already allowed. The safe default, and the noisiest.',
  acceptEdits: 'File edits go through without asking; commands, network calls and everything else still prompt.',
  auto: 'The provider’s own classifier decides what is routine, and prompts when it judges a call risky.',
  dontAsk: 'Never prompt. A call that would have needed approval is denied instead of asked about.',
  bypassPermissions: 'Every tool call runs, including destructive ones, with no prompt and no second look.',
};

/**
 * Nothing in the renderer persists a tool policy yet.
 *
 * Stated once, as one sentence per control, because each control needs its own
 * reason attached — a single note above the group would leave three dimmed
 * boxes with no explanation on the box itself.
 */
const NO_TOOL_POLICY =
  'Artemis has nowhere to keep this yet. The protocol carries it per run, but no setting writes it, so anything typed here would be lost when this dialog closes.';

export function PermissionsSection(): ReactElement {
  const modes = usePermissionModes();
  const mode = usePane((s) => s.permissionMode);
  const providerLabel = usePane(activeProviderLabel);
  const providerId = usePane((s) => s.activeProviderId);
  const browserMode = useApp((s) => s.browserMode);
  const browserExtensionId = useApp((s) => s.browserExtensionId);
  const reach = useApp((s) => s.extensionReach);
  /*
   * Selected as the array, then folded here.
   *
   * A selector that returned `{ anyPaired, anyConnected }` would build a new
   * object on every store notification, which `useApp` compares by identity —
   * an infinite render loop, and one that only appears once something else in
   * the window starts changing. The array is a reference the store holds, so
   * selecting it is stable.
   */
  const pairedBrowsers = useApp((s) => s.extensionBridge?.browsers);
  const browserContext = browserModeContext(pairedBrowsers, providerId);

  /**
   * The four modes plus a row per paired browser, each carrying its own reason
   * for being unavailable.
   *
   * Built here rather than held as a constant because most of it depends on
   * the machine right now — which provider this conversation runs as, which
   * browsers are paired, and which of those are awake — and a picker that
   * offered an option the run would then decline would be a control that
   * changed nothing. The rows themselves come from `browserPickerOptions`, so
   * this list and the one in a conversation's own menu cannot drift.
   */
  const browserChoices: readonly Choice<string>[] = browserPickerOptions(browserContext).map(
    (option) => ({
      id: option.id,
      label: option.label,
      note: option.note,
      ...(option.unavailable === undefined
        ? {}
        : { disabled: true, reason: option.unavailable }),
    }),
  );

  /**
   * A stored mode the current provider does not accept.
   *
   * Routine rather than exceptional: the preference is global and persisted,
   * and providers accept different subsets, so switching provider strands it.
   * The run falls back to the provider's own default, and saying so is the
   * whole point — otherwise the pane shows nothing selected and looks broken.
   */
  const orphaned = modes.length > 0 && !modes.includes(mode);

  const choices: readonly Choice<PermissionMode>[] = modes.map((id) => ({
    id,
    label: MODE_LABELS[id],
    note: MODE_NOTES[id],
    ...(id === 'bypassPermissions' ? { tone: 'signal' as const } : {}),
  }));

  return (
    <SettingsPane
      title="Permissions & access"
      description="When the agent has to stop and ask you, what it is allowed to reach, and whose browser it reaches the web through."
    >
      <SettingsGroup label="Default permission mode">
        {modes.length === 0 ? (
          <Empty className="mx-3 my-2.5 border border-dashed border-hairline py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ShieldIcon />
              </EmptyMedia>
              <EmptyTitle className="text-ink">No permission modes to choose from</EmptyTitle>
              <EmptyDescription className="text-2xs">
                {providerLabel} does not expose permission modes. It decides on its own whether to
                prompt, and Artemis has no way to ask it for something different.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <ChoiceList
              label="Default permission mode"
              value={mode}
              choices={choices}
              onChange={setPermissionMode}
            />
            <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink-faint">
              Applies to the next run. A run already in flight keeps the mode it started with.
            </p>
            {orphaned ? (
              <p className="px-3 py-2.5 text-2xs leading-relaxed text-amber">
                “{mode}” was chosen under a different provider. {providerLabel} does not accept it,
                so the next run will use the provider’s own default until you pick one above.
              </p>
            ) : null}
          </>
        )}
      </SettingsGroup>

      {/* After the mode list, deliberately: the modes decide what runs without
          asking, and this decides what the agent may reach while it runs —
          the same question, asked of the web. See the file header. */}
      <SettingsGroup label="Browser">
        <ChoiceList
          label="Which browser the agent uses"
          value={browserChoiceValue(browserMode, browserExtensionId)}
          choices={browserChoices}
          onChange={(value) => {
            // `null` cannot come back here: the window's picker has no "follow
            // the default" row, so every row it draws names a mode. The
            // fallback is what keeps that a compile-time fact rather than a
            // hope about the rows.
            const chosen = browserChoiceOf(value);
            setBrowserMode(chosen.mode ?? 'embedded', chosen.browserId);
          }}
        />
        <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink-faint">
          Applies to the next run. A run already in flight keeps the browser it started with.
          Pairing your Chrome, and what the agent may read on each site, are in Settings → Browser.
        </p>
      </SettingsGroup>

      {/* Only about the paired Chrome, so it is its own group rather than a
          line under the picker: the other three modes grant nothing that
          depends on this, and a "how do conversations get it" note attached to
          a four-option list would read as applying to all four. */}
      <SettingsGroup label="How conversations get your Chrome">
        <ChoiceList
          label="How conversations get your Chrome"
          value={reach}
          choices={REACH_CHOICES}
          onChange={setExtensionReach}
        />
      </SettingsGroup>

      <SettingsGroup label="Tool policy">
        <ToolPolicyField
          id="settings-allowed-tools"
          label="Always allow"
          placeholder={'Read\nGrep'}
          description="Tool names that never prompt, one per line, whatever the mode above says."
        />
        <ToolPolicyField
          id="settings-disallowed-tools"
          label="Never allow"
          placeholder={'Bash(rm:*)\nWebFetch'}
          description="Tool names that are always refused. Applied after the allow list, so it wins."
        />
        <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink-faint">
          Until these are real settings, tool policy comes from wherever the provider’s own CLI
          reads it — its config file for this project. Artemis sends no allow list and no deny list,
          so nothing here is silently overriding what you configured there.
        </p>
        <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink-faint">
          <span className="text-ink-muted">Additional directories</span> are set per session, not
          here: open the directory chip above the composer and use{' '}
          <span className="text-ink-muted">Additional folders</span> to let a run read outside the
          project. Enabled team memory banks are attached there automatically.
        </p>
      </SettingsGroup>
    </SettingsPane>
  );
}

function ToolPolicyField({
  id,
  label,
  description,
  placeholder,
}: {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly placeholder: string;
}): ReactElement {
  return (
    <Field className="px-3 py-2.5">
      <FieldLabel htmlFor={id} className="chrome-label text-ink-faint">
        {label}
      </FieldLabel>
      {/*
        `WithReason` rather than a bare `disabled`: a disabled textarea takes no
        pointer events and no focus, so a tooltip on the control itself could
        never open and a keyboard user would never learn why it is dead. The
        wrapper is the focusable stand-in — see `disabled-reason.tsx`.
      */}
      <WithReason reason={NO_TOOL_POLICY} side="top" className="w-full">
        <Textarea
          id={id}
          rows={2}
          disabled
          readOnly
          spellCheck={false}
          placeholder={placeholder}
          className="min-h-14 w-full font-mono text-xs md:text-xs"
        />
      </WithReason>
      <FieldDescription className="text-2xs">{description}</FieldDescription>
    </Field>
  );
}
