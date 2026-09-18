/**
 * Skills — the procedures an agent can load, and the ones that always apply.
 * ============================================================================
 *
 * A skill is a folder with a `SKILL.md` in it. Artemis has delivered them to
 * sessions for a while; what it never did was *show* them, so the only way to
 * learn what a conversation would be offered was to start one and type `/`.
 * This pane is that list, read off the disk each time it opens.
 *
 * ---------------------------------------------------------------------------
 * WHAT A ROW SAYS, AND WHY EACH PART IS THERE
 * ---------------------------------------------------------------------------
 *
 *  - **The command**, in the form a Claude session knows it by. It is drawn as
 *    something to type because that is what it is; the composer's menu finds
 *    it from the bare name, and the row says so once, under the list.
 *  - **The description**, which is the skill's own and is also what the model
 *    chooses it by — so an empty one is called out rather than left blank: a
 *    skill nobody described is a skill the model will never reach for.
 *  - **How it can be reached.** Two frontmatter switches decide that, and the
 *    combinations read very differently in use: a skill the model may pick up
 *    by itself, one that only ever runs when typed, one that is background
 *    knowledge with no command at all.
 *  - **Where it lives**, in a person's terms — this account, every account.
 *
 * ---------------------------------------------------------------------------
 * ALWAYS ON IS A STANDING INSTRUCTION WITH SOMEONE ELSE'S TEXT
 * ---------------------------------------------------------------------------
 *
 * Normally a skill's body stays on disk until the model decides it applies.
 * That is right for "how to cut a release" and wrong for "how I want prose
 * written", which should simply be true of every conversation. The switch
 * appends the body to the system prompt of every run it can reach, exactly as
 * the Instructions pane does with the user's own prompts.
 *
 * It costs what it weighs, on every run, so the row says how much *before* the
 * switch is thrown. And it reaches only where an append can: the footnote
 * names the accounts it cannot reach rather than letting a switch that reads
 * "on" imply a Codex session was told anything.
 *
 * A choice naming a skill that is not on this machine is still drawn — marked
 * missing, with its switch on — because the alternative is a choice the user
 * made becoming invisible and unremovable the moment its folder is away.
 *
 * ---------------------------------------------------------------------------
 * REPOSITORIES: THE LIST OF SKILLS A PERSON WANTS, KEPT IN ONE PLACE
 * ---------------------------------------------------------------------------
 *
 * Skills used to reach a machine by someone putting them there: an installer
 * run by hand on each one, and a scheduled task to keep each copy fresh. A
 * repository named here is cloned under Artemis's own data folder and pulled
 * behind the runs, so the same list is on every machine Artemis is on and
 * nobody maintains it per machine.
 *
 * A row says what a person needs to trust the copy — how many skills it holds,
 * when it last synced, the commit it is at — and when a sync fails it says why
 * in git's own words *and* that the copy it already had is still being used,
 * because the first thing anyone wants to know about a failed sync is whether
 * their skills just vanished. They did not.
 *
 * The Add button is disabled by the same rule the main process refuses with
 * (`skillSourceUrlProblem`), and the reason is shown as it is typed: a URL with
 * a token in it is refused here, before it can be saved anywhere.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { SparklesIcon } from 'lucide-react';
import { formatRelative } from '@rx-artemis/transcript';
import {
  composesAlwaysOnSkillsHere,
  DEFAULT_SKILL_SOURCE_SUBDIR,
  isAlwaysOn,
  skillSlashCommand,
  skillSourceLabel,
  skillSourceSubdirProblem,
  skillSourceUrlProblem,
  type SkillInfo,
  type SkillLibraryDocument,
  type SkillSourceStatus,
} from '@rx-artemis/protocol';

import { useServerSkills } from '../../hooks/useServerSkills';
import { useSkills } from '../../hooks/useSkills';
import { useApp } from '../../state/store';
import { SettingsGroup, SettingsPane } from './pane';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

/**
 * Roughly how many tokens a body is.
 *
 * Four characters to a token is the usual rule of thumb for English prose and
 * is all the precision this needs: the point is the order of magnitude — two
 * hundred or five thousand — not a figure to bill against.
 */
function approximateTokens(chars: number): string {
  const tokens = Math.max(1, Math.round(chars / 4));
  if (tokens < 1_000) return String(Math.round(tokens / 10) * 10 || tokens);
  return `${(tokens / 1_000).toFixed(1)}k`;
}

/** How the skill can be reached, as one plain sentence. */
function reach(skill: SkillInfo): string {
  if (skill.modelInvocable && skill.userInvocable) return 'The model picks it up when it applies, or type the command.';
  if (skill.userInvocable) return 'Runs only when you type the command.';
  if (skill.modelInvocable) return 'Background knowledge: the model uses it when it applies, and it has no command.';
  return 'Switched off in its own file: neither the model nor a command reaches it.';
}

function SkillRow({
  skill,
  on,
  told,
  profileLabel,
  sourceLabel,
  onToggle,
  remote,
}: {
  readonly skill: SkillInfo;
  /**
   * The server this row is about, when it is not this machine: its profile's
   * id and the label a person knows it by. The same skill can be on both, so
   * the row's id and its switch's name have to say which one they are.
   */
  readonly remote?: { readonly id: string; readonly label: string };
  readonly on: boolean;
  /** Whether any account the skill reaches is given its always-on skills. */
  readonly told: boolean;
  readonly profileLabel: (id: string) => string;
  /** What to call the repository a synced skill came from. */
  readonly sourceLabel: (sourceId: string) => string;
  readonly onToggle: (on: boolean) => void;
}): ReactElement {
  const everyAccount = remote === undefined ? 'Every account on this machine' : `Every account on ${remote.label}`;
  const where =
    skill.origin.kind === 'profile'
      ? `Only on ${skill.origin.profileIds.map(profileLabel).join(', ')}`
      : skill.origin.kind === 'source'
        ? `${everyAccount}, from ${sourceLabel(skill.origin.sourceId)}`
        : everyAccount;

  return (
    <Item size="sm" className="items-start">
      <ItemContent>
        <ItemTitle className="text-xs text-ink">
          <code className="font-mono text-2xs text-beam-text">{skillSlashCommand(skill.offeredAs ?? skill.name)}</code>
        </ItemTitle>
        <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-muted">
          {skill.description.length > 0
            ? skill.description
            : 'No description. The model chooses a skill by this line, so it will never pick this one by itself.'}
        </ItemDescription>
        <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
          {reach(skill)} {where}.
          {skill.bodyChars === 0
            ? ' Its file has no instructions in it, so always on would add nothing.'
            : told
              ? ` Always on adds about ${approximateTokens(skill.bodyChars)} tokens to every run.`
              : ' None of the accounts it reaches is told its always-on skills, so the switch adds nothing to a run.'}
        </ItemDescription>
        {/* A session is handed an enabled marketplace plugin whole, so where one
            offers this name Artemis leaves its own copy out rather than offer
            the skill twice. Said here because the command above is then not
            the one that works on those accounts. */}
        {skill.pluginOffers?.map((offer) => (
          <ItemDescription
            key={offer.plugin}
            className="line-clamp-none text-2xs leading-relaxed text-ink-faint"
          >
            On {offer.profileIds.map(profileLabel).join(', ')} the {offer.plugin} plugin offers a skill of this
            name, so sessions there get that one and it is typed as{' '}
            <code className="font-mono text-2xs text-ink-muted">{offer.command}</code>. Always on still uses
            your copy.
          </ItemDescription>
        ))}
      </ItemContent>
      <ItemActions>
        <Switch
          id={remote === undefined ? `settings-skill-${skill.name}` : `settings-skill-${remote.id}-${skill.name}`}
          aria-label={
            remote === undefined ? `Always on: ${skill.name}` : `Always on: ${skill.name}, on ${remote.label}`
          }
          checked={on}
          onCheckedChange={onToggle}
        />
      </ItemActions>
    </Item>
  );
}

/** One subscribed repository: what it is, how its copy is doing, what can be done about it. */
function SourceRow({
  status,
  busy,
  disabled,
  onSync,
  onRemove,
  readOnly = false,
}: {
  readonly status: SkillSourceStatus;
  /** This row's own action is running. */
  readonly busy: boolean;
  /** Some source action is running; one at a time. */
  readonly disabled: boolean;
  readonly onSync: () => void;
  readonly onRemove: () => void;
  /** Drawn without its buttons: a server's repository, seen through a token that may not change it. */
  readonly readOnly?: boolean;
}): ReactElement {
  const label = skillSourceLabel(status.source.url);
  const count = `${String(status.skillCount)} skill${status.skillCount === 1 ? '' : 's'}`;
  const synced = status.syncedAt === undefined ? null : formatRelative(status.syncedAt);

  return (
    <Item size="sm" className="items-start">
      <ItemContent>
        <ItemTitle className="text-xs text-ink">{label}</ItemTitle>
        <ItemDescription className="line-clamp-none break-all font-mono text-2xs leading-relaxed text-ink-faint">
          {status.source.url}
          {status.source.subdir === DEFAULT_SKILL_SOURCE_SUBDIR ? '' : ` · ${status.source.subdir}/`}
        </ItemDescription>
        {status.error !== undefined ? (
          <ItemDescription role="alert" className="line-clamp-none text-2xs leading-relaxed text-danger-text">
            Could not sync: {status.error}
            {status.cloned
              ? ` Still using the copy it has${synced === null ? '' : `, from ${synced}`}: ${count}.`
              : ' Nothing has been cloned yet, so it offers no skills.'}
          </ItemDescription>
        ) : (
          <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
            {status.cloned
              ? [count, synced === null ? null : `synced ${synced}`, status.head ?? null]
                  .filter((part): part is string => part !== null)
                  .join(' · ')
              : 'Not cloned yet.'}
          </ItemDescription>
        )}
      </ItemContent>
      {readOnly ? null : (
        <ItemActions>
          <Button
            size="sm"
            variant="ghost"
            className="text-2xs"
            disabled={disabled}
            aria-label={`Pull now: ${label}`}
            onClick={onSync}
          >
            {busy ? 'Working…' : 'Pull now'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-2xs text-ink-faint"
            disabled={disabled}
            aria-label={`Remove: ${label}`}
            onClick={onRemove}
          >
            Remove
          </Button>
        </ItemActions>
      )}
    </Item>
  );
}

/**
 * The form that subscribes to a repository.
 *
 * The URL's problem is shown as it is typed and is the *only* thing that
 * disables Add — the rule main refuses with, so nothing can be typed here that
 * main would then reject with a different sentence. An empty field shows no
 * complaint: nobody has done anything wrong by not typing yet.
 */
function AddSourceForm({
  busy,
  disabled,
  onAdd,
  remote,
}: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onAdd: (url: string, subdir: string) => Promise<boolean>;
  /** The server the repository is cloned on, when it is not this machine. */
  readonly remote?: string;
}): ReactElement {
  const [url, setUrl] = useState('');
  const [subdir, setSubdir] = useState<string>(DEFAULT_SKILL_SOURCE_SUBDIR);
  const typed = url.trim().length > 0;
  const problem = typed ? (skillSourceUrlProblem(url) ?? skillSourceSubdirProblem(subdir)) : null;

  const submit = async (): Promise<void> => {
    if (!typed || problem !== null || disabled) return;
    // Cleared only when it took: a URL that failed to add is one the person is
    // about to correct, not retype.
    if (await onAdd(url.trim(), subdir.trim())) setUrl('');
  };

  return (
    <form
      className="flex flex-col gap-1.5 px-3 py-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-1.5">
        <Input
          aria-label={remote === undefined ? 'Repository URL' : `Repository URL, for ${remote}`}
          placeholder="https://github.com/you/agent-skills.git"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          className="h-7 min-w-0 flex-1 font-mono text-2xs"
          spellCheck={false}
          autoComplete="off"
        />
        <Input
          aria-label={
            remote === undefined ? 'Folder that holds the skills' : `Folder that holds the skills, for ${remote}`
          }
          value={subdir}
          onChange={(event) => setSubdir(event.target.value)}
          className="h-7 w-24 font-mono text-2xs"
          spellCheck={false}
          autoComplete="off"
        />
        <Button type="submit" size="sm" disabled={!typed || problem !== null || disabled}>
          {busy ? 'Cloning…' : 'Add'}
        </Button>
      </div>
      {problem !== null ? (
        <p role="alert" className="text-2xs leading-relaxed text-danger-text">
          {problem}
        </p>
      ) : (
        <p className="text-2xs leading-relaxed text-ink-faint">
          {remote === undefined ? (
            <>
              A git repository with one folder per skill. Artemis clones it under its own data folder and
              keeps it pulled, so the same skills are on every machine you add it to. A private repository is
              reached with this machine&rsquo;s own git credentials.
            </>
          ) : (
            <>
              Cloned on {remote}, under its own data folder, and kept pulled there. A private repository is
              reached with that server&rsquo;s git credentials, not this machine&rsquo;s.
            </>
          )}
        </p>
      )}
    </form>
  );
}

/**
 * What one Artemis server carries.
 *
 * A conversation on a server runs there, so it is offered *these* skills and
 * the switches on these rows are what reach it: the choice is the one kept on
 * this machine, sent by name when a run starts, and the server reads the body
 * off its own disk. A name switched on here and absent there adds nothing to a
 * served run, which is why the list is worth drawing at all.
 *
 * The repositories are the server's own, cloned on its disk with its
 * credentials. A token with the administrative grant keeps them in step from
 * here; any other sees them and is told why it cannot.
 */
function ServerSkillsGroup({
  profileId,
  label,
  document,
  onToggle,
  onNames,
}: {
  readonly profileId: string;
  readonly label: string;
  readonly document: SkillLibraryDocument;
  readonly onToggle: (name: string, on: boolean) => void;
  /** Tells the pane which names exist here, so a choice is not called missing. */
  readonly onNames: (profileId: string, names: readonly string[]) => void;
}): ReactElement | null {
  const server = useServerSkills(profileId);
  const state = server.state;

  useEffect(() => {
    onNames(profileId, state === null ? [] : state.skills.map((skill) => skill.name));
  }, [onNames, profileId, state]);

  if (server.loading) return null;
  const anchor = `skills-server-${profileId}`;

  if (server.error !== null || state === null) {
    return (
      <SettingsGroup label={`On ${label}`} anchor={anchor}>
        <p role="alert" className="px-3 py-2.5 text-2xs leading-relaxed text-danger-text">
          Could not ask {label} for its skills: {server.error ?? 'it did not answer.'}
        </p>
      </SettingsGroup>
    );
  }
  if (!state.available) {
    return (
      <SettingsGroup label={`On ${label}`} anchor={anchor}>
        <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink-faint">
          This server does not list its skills, so it is too old to read always-on skills either.
          Conversations there start without them until it is updated.
        </p>
      </SettingsGroup>
    );
  }

  const accountLabel = (id: string): string =>
    state.accounts.find((account) => account.id === id)?.label ?? 'an account that is no longer there';
  const sourceLabel = (sourceId: string): string => {
    const status = state.sources.find((candidate) => candidate.source.id === sourceId);
    return status === undefined ? 'a repository that is no longer there' : skillSourceLabel(status.source.url);
  };

  return (
    <SettingsGroup label={`On ${label}`} anchor={anchor}>
      {state.skills.length > 0 ? (
        <ItemGroup className="gap-0 divide-y divide-hairline">
          {state.skills.map((skill) => (
            <SkillRow
              key={skill.name}
              skill={skill}
              remote={{ id: profileId, label }}
              on={isAlwaysOn(document, skill.name)}
              told
              profileLabel={accountLabel}
              sourceLabel={sourceLabel}
              onToggle={(on) => onToggle(skill.name, on)}
            />
          ))}
        </ItemGroup>
      ) : (
        <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink-faint">
          No skills on this server yet. Add a repository below and conversations there are offered what it
          holds from the next message on.
        </p>
      )}

      {server.actionError !== null ? (
        <p role="alert" className="px-3 pt-2.5 text-2xs leading-relaxed text-danger-text">
          {server.actionError}
        </p>
      ) : null}
      {state.sources.length > 0 ? (
        <ItemGroup className="gap-0 divide-y divide-hairline border-t border-hairline">
          {state.sources.map((status) => (
            <SourceRow
              key={status.source.id}
              status={status}
              readOnly={!state.manage}
              busy={server.busy === status.source.id || server.busy === 'all'}
              disabled={server.busy !== null}
              onSync={() => server.syncSources(status.source.id)}
              onRemove={() => server.removeSource(status.source.id)}
            />
          ))}
        </ItemGroup>
      ) : null}
      {state.manage ? (
        <AddSourceForm
          busy={server.busy === 'add'}
          disabled={server.busy !== null}
          onAdd={server.addSource}
          remote={label}
        />
      ) : (
        <p className="px-3 py-2.5 text-2xs leading-relaxed text-ink-faint">
          This connection can see the server&rsquo;s repositories but not change them. One created with{' '}
          <code className="font-mono">--manage-profiles</code> can.
        </p>
      )}
    </SettingsGroup>
  );
}

export function SkillsSection(): ReactElement {
  const pane = useSkills();
  const profiles = useApp((s) => s.profiles);
  const profileLabel = (id: string): string =>
    profiles.find((profile) => profile.id === id)?.label ?? 'an account that is no longer here';
  const providers = useApp((s) => s.providers);
  /*
   * The engine's own rule, fed what each provider reports about itself, so a
   * row prices always-on only where a run is given it. A provider not yet
   * listed is priced anyway: "adds nothing" said too early would be the lie.
   */
  const toldOn = (profileId: string): boolean => {
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (profile === undefined) return false;
    const provider = providers.find((candidate) => candidate.id === profile.providerId);
    // A served account is told too, but by name and from the *server's* copy:
    // a skill on this machine's disk adds nothing to a run over there, so a
    // local row is priced only by the accounts that read this disk.
    return provider === undefined || composesAlwaysOnSkillsHere(provider.id, provider.capabilities.systemPromptAppend);
  };
  const sourceLabel = (sourceId: string): string => {
    const status = pane.sources.find((candidate) => candidate.source.id === sourceId);
    return status === undefined ? 'a repository that is no longer here' : skillSourceLabel(status.source.url);
  };
  const told = (skill: SkillInfo): boolean =>
    (skill.origin.kind === 'profile' ? skill.origin.profileIds : profiles.map((profile) => profile.id)).some(toldOn);

  // One group per Artemis server this machine has a profile for. A served
  // conversation runs there, with that server's skills.
  const servers = profiles.filter((profile) => profile.providerId === 'artemis');
  const [serverNames, setServerNames] = useState<Readonly<Record<string, readonly string[]>>>({});
  const noteServerNames = useCallback((profileId: string, names: readonly string[]): void => {
    setServerNames((held) => {
      const before = held[profileId];
      if (before !== undefined && before.length === names.length && before.every((name, index) => name === names[index])) {
        return held;
      }
      return { ...held, [profileId]: names };
    });
  }, []);

  // Choices whose skill is nowhere right now: not on this machine, and not on
  // a server a conversation could run on. Kept in view: see the file header.
  const present = new Set([
    ...pane.skills.map((skill) => skill.name),
    ...servers.flatMap((server) => serverNames[server.id] ?? []),
  ]);
  const missing = pane.document.alwaysOn.filter((entry) => !present.has(entry.name));

  return (
    <SettingsPane
      title="Skills"
      description="Procedures your agents can load: what a conversation on this machine is offered, and which ones always apply."
    >
      {pane.error !== null ? (
        <p role="alert" className="text-2xs leading-relaxed text-danger-text">
          Could not read the skills: {pane.error}
        </p>
      ) : null}

      {pane.saveError !== null ? (
        <p role="alert" className="text-2xs leading-relaxed text-danger-text">
          That switch did not take: {pane.saveError}
        </p>
      ) : null}

      {!pane.loading && pane.error === null && pane.skills.length === 0 && missing.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SparklesIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No skills on this machine</EmptyTitle>
            <EmptyDescription>
              A skill is a folder holding a <code className="font-mono">SKILL.md</code>. Put one under{' '}
              <code className="font-mono">~/.agents/skills</code> and every Claude and Codex account here is
              offered it from the next message on — or add a repository of them below, and Artemis keeps
              it current on this machine for you.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {pane.skills.length > 0 ? (
        <SettingsGroup label="On this machine" anchor="skills-list">
          <ItemGroup className="gap-0 divide-y divide-hairline">
            {pane.skills.map((skill) => (
              <SkillRow
                key={skill.name}
                skill={skill}
                on={isAlwaysOn(pane.document, skill.name)}
                told={told(skill)}
                profileLabel={profileLabel}
                sourceLabel={sourceLabel}
                onToggle={(on) => pane.setAlwaysOn(skill.name, on)}
              />
            ))}
          </ItemGroup>
        </SettingsGroup>
      ) : null}

      {missing.length > 0 ? (
        <SettingsGroup label={servers.length > 0 ? 'Always on, but not installed anywhere' : 'Always on, but not on this machine'} anchor="skills-missing">
          <ItemGroup className="gap-0 divide-y divide-hairline">
            {missing.map((entry) => (
              <Item key={entry.name} size="sm" className="items-start">
                <ItemContent>
                  <ItemTitle className="text-xs text-ink">
                    <code className="font-mono text-2xs text-ink-muted">{skillSlashCommand(entry.name)}</code>
                  </ItemTitle>
                  <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                    Its folder is not here right now, so nothing is added to a run. The choice is kept and
                    takes effect again the moment the skill is back.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    id={`settings-skill-${entry.name}`}
                    aria-label={`Always on: ${entry.name}`}
                    checked
                    onCheckedChange={(on) => pane.setAlwaysOn(entry.name, on)}
                  />
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </SettingsGroup>
      ) : null}

      {!pane.loading && pane.error === null ? (
        <SettingsGroup label="Skill repositories" anchor="skills-sources">
          {pane.sourceError !== null ? (
            <p role="alert" className="px-3 pt-2.5 text-2xs leading-relaxed text-danger-text">
              {pane.sourceError}
            </p>
          ) : null}
          {pane.sources.length > 0 ? (
            <ItemGroup className="gap-0 divide-y divide-hairline">
              {pane.sources.map((status) => (
                <SourceRow
                  key={status.source.id}
                  status={status}
                  busy={pane.sourceBusy === status.source.id || pane.sourceBusy === 'all'}
                  disabled={pane.sourceBusy !== null}
                  onSync={() => pane.syncSources(status.source.id)}
                  onRemove={() => pane.removeSource(status.source.id)}
                />
              ))}
            </ItemGroup>
          ) : null}
          <AddSourceForm
            busy={pane.sourceBusy === 'add'}
            disabled={pane.sourceBusy !== null}
            onAdd={pane.addSource}
          />
        </SettingsGroup>
      ) : null}

      {/* After everything about this machine: a server is another place, with its
          own skills and its own repositories. */}
      {!pane.loading && pane.error === null
        ? servers.map((server) => (
            <ServerSkillsGroup
              key={server.id}
              profileId={server.id}
              label={server.label}
              document={pane.document}
              onToggle={pane.setAlwaysOn}
              onNames={noteServerNames}
            />
          ))
        : null}

      {pane.skills.length > 0 || missing.length > 0 ? (
        <p className="text-2xs leading-relaxed text-ink-faint">
          Type <code className="font-mono">/</code> and the skill&rsquo;s own name in a conversation: the menu
          finds it and fills in the full command. <em>Always on</em> appends the skill to the system prompt,
          the way a standing instruction is, so it reaches Claude accounts and local models. A Codex or
          OpenCode account cannot take an appended prompt and is not told. A conversation on an Artemis
          Server runs on the server: the switch travels with it by name, and the server adds its own copy of
          the skill, so one that is not installed there adds nothing.
        </p>
      ) : null}
    </SettingsPane>
  );
}
