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
 */

import type { ReactElement } from 'react';
import { SparklesIcon } from 'lucide-react';
import { isAlwaysOn, skillSlashCommand, type SkillInfo } from '@rx-artemis/protocol';

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
  profileLabel,
  onToggle,
}: {
  readonly skill: SkillInfo;
  readonly on: boolean;
  readonly profileLabel: (id: string) => string;
  readonly onToggle: (on: boolean) => void;
}): ReactElement {
  const where =
    skill.origin.kind === 'profile'
      ? `Only on ${skill.origin.profileIds.map(profileLabel).join(', ')}`
      : 'Every account on this machine';

  return (
    <Item size="sm" className="items-start">
      <ItemContent>
        <ItemTitle className="text-xs text-ink">
          <code className="font-mono text-2xs text-beam-text">{skillSlashCommand(skill.name)}</code>
        </ItemTitle>
        <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-muted">
          {skill.description.length > 0
            ? skill.description
            : 'No description. The model chooses a skill by this line, so it will never pick this one by itself.'}
        </ItemDescription>
        <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
          {reach(skill)} {where}.
          {skill.bodyChars > 0
            ? ` Always on adds about ${approximateTokens(skill.bodyChars)} tokens to every run.`
            : ' Its file has no instructions in it, so always on would add nothing.'}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Switch
          id={`settings-skill-${skill.name}`}
          aria-label={`Always on: ${skill.name}`}
          checked={on}
          onCheckedChange={onToggle}
        />
      </ItemActions>
    </Item>
  );
}

export function SkillsSection(): ReactElement {
  const pane = useSkills();
  const profiles = useApp((s) => s.profiles);
  const profileLabel = (id: string): string =>
    profiles.find((profile) => profile.id === id)?.label ?? 'an account that is no longer here';

  // Choices whose skill is not on this machine right now. Kept in view: see the
  // file header.
  const present = new Set(pane.skills.map((skill) => skill.name));
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
              offered it from the next message on.
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
                profileLabel={profileLabel}
                onToggle={(on) => pane.setAlwaysOn(skill.name, on)}
              />
            ))}
          </ItemGroup>
        </SettingsGroup>
      ) : null}

      {missing.length > 0 ? (
        <SettingsGroup label="Always on, but not on this machine" anchor="skills-missing">
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

      {pane.skills.length > 0 || missing.length > 0 ? (
        <p className="text-2xs leading-relaxed text-ink-faint">
          Type <code className="font-mono">/</code> and the skill&rsquo;s own name in a conversation: the menu
          finds it and fills in the full command. <em>Always on</em> appends the skill to the system prompt,
          the way a standing instruction is, so it reaches Claude accounts and local models. A Codex or
          OpenCode account cannot take an appended prompt and is not told; a conversation on an Artemis
          Server runs on the server, with the server&rsquo;s skills, and these switches do not reach it yet.
        </p>
      ) : null}
    </SettingsPane>
  );
}
