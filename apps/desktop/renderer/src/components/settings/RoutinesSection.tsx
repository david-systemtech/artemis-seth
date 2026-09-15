/**
 * Routines — the pane where appointments are made.
 *
 * A list of scheduled runs and one form, following the profile screen's
 * grammar: cards for what exists, a bordered form for what is being made. Two
 * things a routine now decides that it did not before, and both are the point
 * of this pane rather than chrome on it:
 *
 *  - **Where it runs.** *Local* fires while this app is open, through the
 *    desktop's own scheduler; *Server* fires in a server, on schedule, with
 *    this app closed. The account, the model and the effort levels on offer all
 *    follow from that choice — a local routine bills a local account, a server
 *    routine bills one the server serves.
 *  - **How it opens.** A scheduled run has nobody in front of it, so it opens in
 *    bypass-permissions by default. A local routine may be given a stricter
 *    mode that pauses on a prompt (the desktop can show it); a server routine
 *    cannot, because there is nobody there to answer — so its mode is fixed and
 *    the form says so.
 *
 * The schedule itself and its minute math live in `@rx-artemis/protocol`, so
 * what this file owns is only the asking — every "when does this fire next" is
 * `nextFireAt` from the same module the schedulers tick on.
 */

import { useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react';
import { PauseIcon, PlayIcon, PlusIcon, Trash2Icon, ZapIcon } from 'lucide-react';

import {
  describeSchedule,
  scheduleProblem,
  type PermissionMode,
  type ProviderId,
  type RoutineDraft,
  type RoutineRunRecord,
  type RoutineSchedule,
  type ServerModel,
  type ServerProfile,
} from '@rx-artemis/protocol';

import { useRoutines, type RoutineLocation, type RoutineRow } from '@/hooks/useRoutines';
import { formatRelative, formatUntil } from '@rx-artemis/transcript';
import { shortenPath } from '../../lib/paths';
import { activeModels, readServerAccounts, useApp } from '../../state/store';
import { usePane } from '../../state/paneContext';
import { SettingsPane } from './pane';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ToneBadge } from '../primitives';
import { IconButton } from '../disabled-reason';
import { cn } from '@/lib/utils';

/** The provider id every Artemis-Server profile carries. See `useRoutines`. */
const ARTEMIS_SERVER_PROVIDER_ID = 'artemis';

/** The schedule kinds the form offers, in the order they are met. */
const SCHEDULE_KINDS = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'days', label: 'Some days' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'hourly', label: 'Hourly' },
  { id: 'cron', label: 'Cron' },
  { id: 'manual', label: 'Manual' },
] as const;

/** Week order, Monday first, with `Date.getDay`'s numbering as the id. */
const WEEKDAYS = [
  { id: '1', label: 'Monday', short: 'Mon' },
  { id: '2', label: 'Tuesday', short: 'Tue' },
  { id: '3', label: 'Wednesday', short: 'Wed' },
  { id: '4', label: 'Thursday', short: 'Thu' },
  { id: '5', label: 'Friday', short: 'Fri' },
  { id: '6', label: 'Saturday', short: 'Sat' },
  { id: '0', label: 'Sunday', short: 'Sun' },
];

/** What the form holds while a schedule is being described. */
interface ScheduleForm {
  readonly kind: (typeof SCHEDULE_KINDS)[number]['id'];
  readonly at: string;
  readonly minute: string;
  /** Day of week for `weekly`, `Date.getDay`'s numbering. */
  readonly day: string;
  /** Day of month for `monthly`, 1–31. */
  readonly monthDay: string;
  /** The selected days for `days`, as `Date.getDay` ids. */
  readonly days: readonly string[];
  readonly expression: string;
}

const DEFAULT_SCHEDULE_FORM: ScheduleForm = {
  kind: 'daily',
  at: '09:00',
  minute: '0',
  day: '1',
  monthDay: '1',
  days: ['1', '3', '5'],
  expression: '0 9 * * 1-5',
};

function toSchedule(form: ScheduleForm): RoutineSchedule {
  switch (form.kind) {
    case 'manual':
      return { kind: 'manual' };
    case 'hourly':
      return { kind: 'hourly', minute: Number(form.minute) };
    case 'daily':
      return { kind: 'daily', at: form.at };
    case 'weekdays':
      return { kind: 'weekdays', at: form.at };
    case 'weekly':
      return { kind: 'weekly', day: Number(form.day), at: form.at };
    case 'days':
      // Numbered and week-ordered, so the stored list reads the way the toggles
      // are laid out rather than the order they were clicked.
      return {
        kind: 'days',
        days: [...form.days].map(Number).sort((a, b) => a - b),
        at: form.at,
      };
    case 'monthly':
      return { kind: 'monthly', day: Number(form.monthDay), at: form.at };
    case 'cron':
      return { kind: 'cron', expression: form.expression };
  }
}

function toScheduleForm(schedule: RoutineSchedule): ScheduleForm {
  switch (schedule.kind) {
    case 'manual':
      return { ...DEFAULT_SCHEDULE_FORM, kind: 'manual' };
    case 'hourly':
      return { ...DEFAULT_SCHEDULE_FORM, kind: 'hourly', minute: String(schedule.minute) };
    case 'daily':
      return { ...DEFAULT_SCHEDULE_FORM, kind: 'daily', at: schedule.at };
    case 'weekdays':
      return { ...DEFAULT_SCHEDULE_FORM, kind: 'weekdays', at: schedule.at };
    case 'weekly':
      return { ...DEFAULT_SCHEDULE_FORM, kind: 'weekly', day: String(schedule.day), at: schedule.at };
    case 'days':
      return {
        ...DEFAULT_SCHEDULE_FORM,
        kind: 'days',
        days: schedule.days.map(String),
        at: schedule.at,
      };
    case 'monthly':
      return { ...DEFAULT_SCHEDULE_FORM, kind: 'monthly', monthDay: String(schedule.day), at: schedule.at };
    case 'cron':
      return { ...DEFAULT_SCHEDULE_FORM, kind: 'cron', expression: schedule.expression };
  }
}

/** One firing's verdict, in the palette's own words. */
function outcomeTone(row: RoutineRunRecord): 'mint' | 'amber' | 'signal' | 'cyan' {
  switch (row.outcome) {
    case 'completed':
      return 'mint';
    case 'running':
      return 'cyan';
    case 'skipped':
    case 'interrupted':
      return 'amber';
    case 'error':
      return 'signal';
  }
}

function outcomeLabel(row: RoutineRunRecord): string {
  if (row.outcome === 'skipped') {
    return row.skipReason === 'overlap'
      ? 'skipped — still running'
      : `skipped — ${row.skipReason ?? 'skipped'}`;
  }
  if (row.outcome === 'error' && row.endReason !== undefined && row.endReason !== 'error') {
    return row.endReason.replaceAll('_', ' ');
  }
  return row.outcome;
}

export function RoutinesSection(): ReactElement {
  const { state, busy, create, update, remove, runNow } = useRoutines();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const editingRoutine = state.routines.find((routine) => routine.id === editing) ?? null;

  return (
    <SettingsPane
      title="Routines"
      description="Runs Artemis starts on a schedule — same transcripts, same history as a prompt you typed. A local routine fires while this app is open; a server routine fires in a server, with the app closed. A missed appointment fires once on wake, and older misses are let go."
      actions={
        creating || editingRoutine !== null ? null : (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <PlusIcon />
            New routine
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {state.routines.length === 0 && !creating ? (
          <p className="text-2xs leading-relaxed text-ink-faint">
            Nothing scheduled. A routine is a prompt with an appointment — a morning triage, a
            nightly digest — run under the account you pick, on this machine or on a server.
          </p>
        ) : null}

        {creating || editingRoutine !== null ? (
          <RoutineForm
            key={editingRoutine?.id ?? 'new'}
            routine={editingRoutine}
            busy={busy}
            onCancel={() => {
              setCreating(false);
              setEditing(null);
            }}
            onSubmit={(location, draft) => {
              if (editingRoutine === null) create(location, draft);
              else update(location, editingRoutine.id, draft);
              setCreating(false);
              setEditing(null);
            }}
          />
        ) : (
          state.routines.map((routine) => (
            <RoutineCard
              key={`${routine.location.kind === 'server' ? routine.location.profileId : 'local'}:${routine.id}`}
              routine={routine}
              busy={busy}
              onEdit={() => setEditing(routine.id)}
              onRunNow={() => runNow(routine.location, routine.id)}
              onTogglePause={() => update(routine.location, routine.id, { paused: !routine.paused })}
              onDelete={() => remove(routine.location, routine.id)}
            />
          ))
        )}
      </div>
    </SettingsPane>
  );
}

function RoutineCard({
  routine,
  busy,
  onEdit,
  onRunNow,
  onTogglePause,
  onDelete,
}: {
  readonly routine: RoutineRow;
  readonly busy: boolean;
  readonly onEdit: () => void;
  readonly onRunNow: () => void;
  readonly onTogglePause: () => void;
  readonly onDelete: () => void;
}): ReactElement {
  const profiles = useApp((s) => s.profiles);
  const profile = profiles.find((entry) => entry.id === routine.profileId);
  const where =
    routine.location.kind === 'server' ? `Server · ${routine.location.profileLabel}` : 'Local';

  return (
    <Card className="rounded-lg border-hairline">
      <CardContent className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">
            {routine.name}
          </span>
          <ToneBadge tone={routine.location.kind === 'server' ? 'beam' : 'neutral'}>{where}</ToneBadge>
          {routine.running ? <ToneBadge tone="cyan">running</ToneBadge> : null}
          {routine.paused ? <ToneBadge tone="amber">paused</ToneBadge> : null}
          <IconButton
            label="Run now"
            disabled={busy || routine.running}
            disabledReason={routine.running ? 'A firing is already running.' : undefined}
            onClick={onRunNow}
          >
            <ZapIcon />
          </IconButton>
          <IconButton
            label={routine.paused ? 'Resume the schedule' : 'Pause the schedule'}
            disabled={busy}
            onClick={onTogglePause}
          >
            {routine.paused ? <PlayIcon /> : <PauseIcon />}
          </IconButton>
          <IconButton
            label="Delete the routine and its history"
            disabled={busy}
            onClick={onDelete}
          >
            <Trash2Icon />
          </IconButton>
        </div>

        <button
          type="button"
          className="flex flex-col items-start gap-0.5 text-left"
          onClick={onEdit}
        >
          <span className="text-2xs text-ink-muted">
            {describeSchedule(routine.schedule)}
            {routine.nextFireAt === undefined ? '' : ` — next ${formatUntil(routine.nextFireAt)}`}
          </span>
          <span className="text-2xs text-ink-faint">
            {(profile?.label ?? routine.profileId)}
            {/* A server routine runs in the connection's pinned directory,
                which is the server's business, so its own cwd is not shown. */}
            {routine.location.kind === 'server' ? '' : ` · ${shortenPath(routine.cwd)}`}
            {routine.model === undefined ? '' : ` · ${routine.model}`}
          </span>
        </button>

        {routine.history.length > 0 ? (
          <div className="flex flex-col gap-1 border-t border-hairline pt-2">
            {routine.history.slice(0, 3).map((row) => (
              <div key={`${row.firedAt}`} className="flex items-center gap-2 text-2xs">
                <ToneBadge tone={outcomeTone(row)}>{outcomeLabel(row)}</ToneBadge>
                <span className="text-ink-faint">{formatRelative(row.firedAt)}</span>
                {row.catchUp === true ? (
                  <span className="text-ink-faint">· made up after a sleep</span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* The model and effort pickers                                               */
/* -------------------------------------------------------------------------- */

/** A Radix `SelectItem` may not carry an empty value, so "default" wears a sentinel. */
const DEFAULT_SENTINEL = '__default__';
const NO_PINS: readonly string[] = [];

/** A model as either catalogue reduces to for the picker. */
interface PickableModel {
  readonly id: string;
  readonly label: string;
}

/**
 * Choose a model from a catalogue, or the provider default.
 *
 * The same control for a local account and a served one — both hand it a list
 * of models and the ids to lead with — because a routine aimed at a model that
 * does not exist is the one failure a *scheduled* run cannot afford: there is
 * nobody at the keyboard to read the provider's shrug. Free text survives only
 * where there is no catalogue at all, which a picker would render as an empty
 * menu over a field that used to work.
 */
function ModelPicker({
  models,
  pins,
  value,
  onChange,
}: {
  readonly models: readonly PickableModel[];
  readonly pins: readonly string[];
  readonly value: string;
  readonly onChange: (next: string) => void;
}): ReactElement {
  if (models.length === 0) {
    return (
      <Field>
        <FieldLabel htmlFor="routine-model" className="chrome-label text-ink-faint">
          Model (optional)
        </FieldLabel>
        <Input
          id="routine-model"
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder="Provider default"
          onChange={(event) => onChange(event.target.value)}
          className="font-mono text-xs md:text-xs"
        />
        <FieldDescription className="text-2xs">
          This account published no model list, so the id is sent as written.
        </FieldDescription>
      </Field>
    );
  }

  const known = models.some((model) => model.id === value);
  const pinned = models.filter((model) => pins.includes(model.id));
  const rest = pinned.length === 0 ? models : models.filter((model) => !pins.includes(model.id));

  return (
    <Field>
      <FieldLabel className="chrome-label text-ink-faint">Model (optional)</FieldLabel>
      <Select
        value={value === '' ? DEFAULT_SENTINEL : value}
        onValueChange={(next) => onChange(next === DEFAULT_SENTINEL ? '' : next)}
      >
        <SelectTrigger className="text-xs" aria-label="Model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_SENTINEL} className="text-xs">
            Provider default
          </SelectItem>
          {value !== '' && !known ? (
            <SelectItem value={value} className="font-mono text-xs">
              {value} — not in the catalogue
            </SelectItem>
          ) : null}
          {pinned.length > 0 ? (
            <SelectGroup>
              <SelectLabel className="text-2xs text-ink-faint">Pinned</SelectLabel>
              {pinned.map((model) => (
                <SelectItem key={model.id} value={model.id} className="text-xs">
                  {model.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
          {rest.length > 0 ? (
            <SelectGroup>
              {pinned.length > 0 ? (
                <SelectLabel className="text-2xs text-ink-faint">Catalogue</SelectLabel>
              ) : null}
              {rest.map((model) => (
                <SelectItem key={model.id} value={model.id} className="text-xs">
                  {model.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** The account's effort levels, "Default" plus each. Absent when the account
 * offers none — a control over one choice is a control worth omitting. */
function EffortField({
  levels,
  value,
  onChange,
}: {
  readonly levels: readonly { readonly id: string; readonly label: string }[];
  readonly value: string;
  readonly onChange: (next: string) => void;
}): ReactElement | null {
  if (levels.length === 0) return null;
  return (
    <Field>
      <FieldLabel className="chrome-label text-ink-faint">Effort</FieldLabel>
      <Select
        value={value === '' ? DEFAULT_SENTINEL : value}
        onValueChange={(next) => onChange(next === DEFAULT_SENTINEL ? '' : next)}
      >
        <SelectTrigger className="text-xs" aria-label="Effort">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_SENTINEL} className="text-xs">
            Default
          </SelectItem>
          {levels.map((level) => (
            <SelectItem key={level.id} value={level.id} className="text-xs">
              {level.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/* -------------------------------------------------------------------------- */
/* The form                                                                   */
/* -------------------------------------------------------------------------- */

/** A local account is where a local routine's model, effort and modes come from. */
function useLocalCatalogue(profileId: string): {
  readonly models: readonly PickableModel[];
  readonly pins: readonly string[];
  readonly effortLevels: readonly { id: string; label: string }[];
  readonly permissionModes: readonly PermissionMode[];
} {
  const profiles = useApp((s) => s.profiles);
  const providers = useApp((s) => s.providers);
  const paneProviderId = usePane((s) => s.activeProviderId);
  const paneCatalogue = usePane(activeModels);
  const pins = usePane((s) => s.quickModelIdsByProfile[profileId]) ?? NO_PINS;

  const providerId = profiles.find((profile) => profile.id === profileId)?.providerId;
  const descriptor = providers.find((provider) => provider.id === providerId);
  const rawModels =
    providerId !== undefined && providerId === paneProviderId
      ? paneCatalogue
      : (descriptor?.models ?? []);
  return {
    models: rawModels.map((model) => ({ id: model.id, label: model.displayName ?? model.label })),
    pins,
    effortLevels: (descriptor?.effortLevels ?? []).map((level) => ({
      id: level.id,
      label: level.label,
    })),
    permissionModes: descriptor?.capabilities.permissionModes ?? [],
  };
}

function RoutineForm({
  routine,
  busy,
  onSubmit,
  onCancel,
}: {
  readonly routine: RoutineRow | null;
  readonly busy: boolean;
  readonly onSubmit: (location: RoutineLocation, draft: RoutineDraft) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const profiles = useApp((s) => s.profiles);
  const localProfiles = profiles.filter(
    (profile) => profile.providerId !== ARTEMIS_SERVER_PROVIDER_ID,
  );
  const serverProfiles = profiles.filter(
    (profile) => profile.providerId === ARTEMIS_SERVER_PROVIDER_ID,
  );

  // Editing cannot move a routine between machines — that is a delete and a
  // create — so the location is fixed while editing and free while creating.
  const editingLocation = routine?.location ?? null;

  const [name, setName] = useState(routine?.name ?? '');
  const [instructions, setInstructions] = useState(routine?.instructions ?? '');
  const [cwd, setCwd] = useState(routine?.cwd ?? '');
  /** `'local'` or a server profile id. */
  const [where, setWhere] = useState<string>(
    editingLocation === null
      ? 'local'
      : editingLocation.kind === 'server'
        ? editingLocation.profileId
        : 'local',
  );
  const isServer = where !== 'local';

  // The account each firing bills: a local profile id, or a served account's id.
  const [accountId, setAccountId] = useState(routine?.profileId ?? localProfiles[0]?.id ?? '');
  const [model, setModel] = useState(routine?.model ?? '');
  const [effort, setEffort] = useState(routine?.effort ?? '');
  // A new routine opens in bypass — a scheduled run has nobody to approve a
  // prompt. Stored explicitly rather than left to the host so the choice is
  // always on the record.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    routine?.permissionMode ?? 'bypassPermissions',
  );
  const [schedule, setSchedule] = useState<ScheduleForm>(
    routine === null ? DEFAULT_SCHEDULE_FORM : toScheduleForm(routine.schedule),
  );
  const [error, setError] = useState<string | null>(null);

  // The served accounts for the chosen server, read on demand — a page of that
  // server's state one pane renders while it is open, not app-wide state.
  const [servedAccounts, setServedAccounts] = useState<readonly ServerProfile[]>([]);
  useEffect(() => {
    if (!isServer) {
      setServedAccounts([]);
      return;
    }
    let live = true;
    void readServerAccounts(where as never).then((result) => {
      if (live && 'accounts' in result) setServedAccounts(result.accounts);
    });
    return () => {
      live = false;
    };
  }, [isServer, where]);

  const local = useLocalCatalogue(isServer ? '' : accountId);
  const servedAccount = servedAccounts.find((account) => String(account.id) === accountId);

  // The model and effort catalogues follow the account: a served account's own
  // models and per-model thinking levels, or the local descriptor's.
  const serverModels: readonly PickableModel[] = (servedAccount?.models ?? []).map((m: ServerModel) => ({
    id: m.id,
    label: m.displayName ?? m.label,
  }));
  const models = isServer ? serverModels : local.models;
  const pins = isServer ? NO_PINS : local.pins;
  const serverEffort = useMemo(() => {
    const chosen = (servedAccount?.models ?? []).find((m) => m.id === model) ?? servedAccount?.models[0];
    return (chosen?.thinkingLevels ?? []).map((level) => ({ id: level.id, label: level.label }));
  }, [servedAccount, model]);
  const effortLevels = isServer ? serverEffort : local.effortLevels;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setError(null);

    if (name.trim() === '' || instructions.trim() === '') {
      setError('A routine needs a name and instructions.');
      return;
    }
    const built = toSchedule(schedule);
    const problem = scheduleProblem(built);
    if (problem !== null) {
      setError(problem);
      return;
    }

    if (isServer) {
      const server = serverProfiles.find((profile) => profile.id === where);
      if (server === undefined) {
        setError('Pick a server — the machine the routine runs on.');
        return;
      }
      if (servedAccount === undefined) {
        setError('Pick an account the server serves.');
        return;
      }
      onSubmit(
        { kind: 'server', profileId: server.id, profileLabel: server.label },
        {
          name: name.trim(),
          instructions,
          profileId: String(servedAccount.id),
          providerId: servedAccount.provider.id,
          ...(model.trim() === '' ? {} : { model: model.trim() }),
          ...(effort.trim() === '' ? {} : { effort: effort.trim() }),
          // A server routine is always unattended, always bypass — there is no
          // one on the far side to answer a prompt, and the park deadline that
          // once denied one has been removed.
          permissionMode: 'bypassPermissions',
          schedule: built,
        },
      );
      return;
    }

    const account = localProfiles.find((profile) => profile.id === accountId);
    if (account === undefined) {
      setError('Pick an account — the profile each firing bills.');
      return;
    }
    if (cwd.trim() === '') {
      setError('A local routine needs a directory to run in.');
      return;
    }
    onSubmit(
      { kind: 'local' },
      {
        name: name.trim(),
        instructions,
        cwd: cwd.trim(),
        profileId: account.id,
        providerId: account.providerId as ProviderId,
        ...(model.trim() === '' ? {} : { model: model.trim() }),
        ...(effort.trim() === '' ? {} : { effort: effort.trim() }),
        permissionMode,
        schedule: built,
      },
    );
  };

  const modeOptions =
    local.permissionModes.length > 0 ? local.permissionModes : (['bypassPermissions', 'default'] as PermissionMode[]);

  return (
    <Card className="rounded-lg border-hairline">
      <CardContent className="p-3">
        <form onSubmit={submit}>
          <div className="flex flex-col gap-3">
            <Field>
              <FieldLabel htmlFor="routine-name" className="chrome-label text-ink-faint">
                Name
              </FieldLabel>
              <Input
                id="routine-name"
                value={name}
                placeholder="Morning triage"
                autoComplete="off"
                autoFocus={routine === null}
                onChange={(event) => setName(event.target.value)}
                className="text-xs md:text-xs"
              />
            </Field>

            <Field>
              <FieldLabel className="chrome-label text-ink-faint">Where it runs</FieldLabel>
              <Select
                value={where}
                disabled={routine !== null}
                onValueChange={(next) => {
                  setWhere(next);
                  // Moving between machines invalidates the account, model and
                  // effort — reset them so a stale local model is not sent to a
                  // server that never heard of it.
                  setAccountId(next === 'local' ? (localProfiles[0]?.id ?? '') : '');
                  setModel('');
                  setEffort('');
                }}
              >
                <SelectTrigger className="text-xs" aria-label="Where it runs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local" className="text-xs">
                    Local — this machine, while Artemis is open
                  </SelectItem>
                  {serverProfiles.length > 0 ? (
                    <SelectGroup>
                      <SelectLabel className="text-2xs text-ink-faint">Servers</SelectLabel>
                      {serverProfiles.map((server) => (
                        <SelectItem key={server.id} value={server.id} className="text-xs">
                          Server · {server.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ) : null}
                </SelectContent>
              </Select>
              {routine !== null ? (
                <FieldDescription className="text-2xs">
                  A routine cannot move between machines — delete it and make a new one to change
                  where it runs.
                </FieldDescription>
              ) : null}
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel className="chrome-label text-ink-faint">Account</FieldLabel>
                <Select value={accountId} onValueChange={setAccountId} disabled={routine !== null}>
                  <SelectTrigger className="text-xs" aria-label="Account">
                    <SelectValue placeholder="Pick an account" />
                  </SelectTrigger>
                  <SelectContent>
                    {(isServer
                      ? servedAccounts.map((account) => ({
                          id: String(account.id),
                          label: account.label,
                        }))
                      : localProfiles.map((profile) => ({ id: profile.id, label: profile.label }))
                    ).map((account) => (
                      <SelectItem key={account.id} value={account.id} className="text-xs">
                        {account.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <ModelPicker models={models} pins={pins} value={model} onChange={setModel} />
            </div>

            <EffortField levels={effortLevels} value={effort} onChange={setEffort} />

            {isServer ? null : (
              <Field>
                <FieldLabel htmlFor="routine-cwd" className="chrome-label text-ink-faint">
                  Directory
                </FieldLabel>
                <Input
                  id="routine-cwd"
                  value={cwd}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="/Users/you/code/project"
                  onChange={(event) => setCwd(event.target.value)}
                  className="font-mono text-xs md:text-xs"
                />
              </Field>
            )}

            <ScheduleField schedule={schedule} onChange={setSchedule} />

            <Field>
              <FieldLabel htmlFor="routine-instructions" className="chrome-label text-ink-faint">
                Instructions
              </FieldLabel>
              <Textarea
                id="routine-instructions"
                value={instructions}
                rows={4}
                placeholder="Read the overnight alerts, summarise anything on fire, and file the rest."
                onChange={(event) => setInstructions(event.target.value)}
                className="text-xs md:text-xs"
              />
            </Field>

            {/* The unattended note, and — for local only — the escape hatch. */}
            {isServer ? (
              <FieldDescription className="text-2xs leading-relaxed">
                A server routine runs unattended, in the connection's own directory, in
                bypass-permissions mode — there is nobody on the server to approve a prompt, so it
                never pauses to ask.
              </FieldDescription>
            ) : (
              <Field>
                <FieldLabel className="chrome-label text-ink-faint">When it needs permission</FieldLabel>
                <Select
                  value={permissionMode}
                  onValueChange={(next) => setPermissionMode(next as PermissionMode)}
                >
                  <SelectTrigger className="text-xs" aria-label="Permission mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {modeOptions.map((mode) => (
                      <SelectItem key={mode} value={mode} className="text-xs">
                        {mode === 'bypassPermissions' ? 'Bypass — run unattended (default)' : mode}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription className="text-2xs leading-relaxed">
                  A scheduled run has nobody watching, so it opens in bypass by default. Pick a
                  stricter mode and a firing will pause on its first prompt — the desktop shows it,
                  exactly as it shows a run you walked away from.
                </FieldDescription>
              </Field>
            )}

            {error !== null ? <p className="text-2xs leading-relaxed text-amber">{error}</p> : null}

            <div className="flex items-center justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                {routine === null ? 'Create routine' : 'Save changes'}
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** The schedule control: a kind, and the one or two fields that kind needs. */
function ScheduleField({
  schedule,
  onChange,
}: {
  readonly schedule: ScheduleForm;
  readonly onChange: (next: ScheduleForm) => void;
}): ReactElement {
  const toggleDay = (id: string): void => {
    const has = schedule.days.includes(id);
    onChange({
      ...schedule,
      days: has ? schedule.days.filter((day) => day !== id) : [...schedule.days, id],
    });
  };

  return (
    <Field>
      <FieldLabel className="chrome-label text-ink-faint">Schedule</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={schedule.kind}
          onValueChange={(kind) => onChange({ ...schedule, kind: kind as ScheduleForm['kind'] })}
        >
          <SelectTrigger className="w-32 text-xs" aria-label="Schedule kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCHEDULE_KINDS.map((kind) => (
              <SelectItem key={kind.id} value={kind.id} className="text-xs">
                {kind.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {schedule.kind === 'weekly' ? (
          <Select value={schedule.day} onValueChange={(day) => onChange({ ...schedule, day })}>
            <SelectTrigger className="w-32 text-xs" aria-label="Day of week">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEEKDAYS.map((day) => (
                <SelectItem key={day.id} value={day.id} className="text-xs">
                  {day.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {schedule.kind === 'monthly' ? (
          <Input
            aria-label="Day of the month"
            value={schedule.monthDay}
            placeholder="1"
            autoComplete="off"
            onChange={(event) => onChange({ ...schedule, monthDay: event.target.value })}
            className="w-16 font-mono text-xs md:text-xs"
          />
        ) : null}

        {schedule.kind === 'daily' ||
        schedule.kind === 'weekdays' ||
        schedule.kind === 'weekly' ||
        schedule.kind === 'days' ||
        schedule.kind === 'monthly' ? (
          <Input
            aria-label="Time of day"
            value={schedule.at}
            placeholder="09:00"
            autoComplete="off"
            onChange={(event) => onChange({ ...schedule, at: event.target.value })}
            className="w-24 font-mono text-xs md:text-xs"
          />
        ) : null}

        {schedule.kind === 'hourly' ? (
          <Input
            aria-label="Minute of the hour"
            value={schedule.minute}
            placeholder="0"
            autoComplete="off"
            onChange={(event) => onChange({ ...schedule, minute: event.target.value })}
            className="w-16 font-mono text-xs md:text-xs"
          />
        ) : null}

        {schedule.kind === 'cron' ? (
          <Input
            aria-label="Cron expression"
            value={schedule.expression}
            placeholder="0 9 * * 1-5"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onChange({ ...schedule, expression: event.target.value })}
            className="w-44 font-mono text-xs md:text-xs"
          />
        ) : null}
      </div>

      {schedule.kind === 'days' ? (
        <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Days of the week">
          {WEEKDAYS.map((day) => {
            const on = schedule.days.includes(day.id);
            return (
              <button
                key={day.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggleDay(day.id)}
                className={cn(
                  'rounded-md border border-hairline px-2 py-1 text-2xs',
                  on ? 'bg-beam text-beam-text' : 'text-ink-muted hover:bg-wash',
                )}
              >
                {day.short}
              </button>
            );
          })}
        </div>
      ) : null}

      <FieldDescription className="text-2xs">
        Local time, one-minute floor. {describeSchedule(toSchedule(schedule))}.
      </FieldDescription>
    </Field>
  );
}
