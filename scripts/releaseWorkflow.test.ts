/**
 * The release workflow's one branch that cannot be run here.
 * ============================================================================
 *
 * Nothing in this repository can execute GitHub Actions, so the release
 * workflow is read rather than run — and the part of it worth reading is the
 * browser extension, because it is the only artifact two jobs have to agree
 * about. The `extension` job builds it; the `build` matrix copies it inside
 * every desktop package; `publish` attaches it to the release.
 *
 * The failure this file exists for had already happened in review. The
 * download was `continue-on-error: true`, which collapsed two states into one:
 *
 *  - **there is no extension in this checkout** — a branch that predates it,
 *    which the workflow supports and which must stay green; and
 *  - **the download failed** — a transient fetch, an expired artifact — which
 *    is not supported at all.
 *
 * Under the second, the matrix packaged an app whose "Get the extension"
 * button does nothing while the release page still carried the zip, and no
 * step in the run said a word about it. So the two are now told apart by an
 * output the `extension` job publishes, and these are the assertions that keep
 * them apart.
 *
 * Structural, against the parsed document rather than its text: a test that
 * matched strings would pass on a workflow that had been reindented into
 * something else entirely.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  readonly uses?: string;
  readonly if?: string;
  readonly id?: string;
  readonly run?: string;
  readonly 'continue-on-error'?: boolean;
  readonly with?: Record<string, unknown>;
}
interface Job {
  readonly needs?: string | readonly string[];
  readonly outputs?: Record<string, string>;
  readonly steps: readonly Step[];
}

const workflow = parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'release.yml'), 'utf8'),
) as { readonly jobs: Record<string, Job> };

const job = (name: string): Job => {
  const found = workflow.jobs[name];
  if (found === undefined) throw new Error(`The release workflow has no "${name}" job.`);
  return found;
};

/** Every step of a job that uses an action, by the action's name. */
const stepsUsing = (name: string, from: Job): readonly Step[] =>
  from.steps.filter((step) => typeof step.uses === 'string' && step.uses.includes(name));

describe('the extension job says whether it built anything', () => {
  it('publishes that as an output the matrix can read', () => {
    // Without it the matrix cannot tell an absent extension from a failed
    // download, and the only way to survive the first is to forgive the second.
    expect(job('extension').outputs?.['built']).toContain('steps.package.outputs.built');
  });

  it('uploads only when there is something to upload, and then insists there is', () => {
    const [upload] = stepsUsing('upload-artifact', job('extension'));
    expect(upload?.if).toContain('built');
    // `ignore` was right while this step ran unconditionally. Now that the
    // condition has already established a file exists, an empty upload is a
    // bug rather than the supported empty case.
    expect(upload?.with?.['if-no-files-found']).toBe('error');
  });
});

describe('the build matrix takes the extension seriously', () => {
  const build = job('build');

  it('runs after the extension job, so the output is there to read', () => {
    expect(build.needs).toContain('extension');
  });

  it('downloads it only when it was built, and never forgives a failure', () => {
    const download = stepsUsing('download-artifact', build).find(
      (step) => step.with?.['name'] === 'extension',
    );
    expect(download).toBeDefined();
    expect(download?.if).toContain("needs.extension.outputs.built == 'true'");
    // The finding itself. A tolerated failure here ships a package whose
    // "Get the extension" button is dead, quietly.
    expect(download?.['continue-on-error']).toBeUndefined();
  });

  it('forgives no step of the matrix, since each one gates a shipped artifact', () => {
    expect(build.steps.filter((step) => step['continue-on-error'] === true)).toEqual([]);
  });

  it('checks the zip is really there before electron-builder copies it', () => {
    // `extraResources` copies whatever it finds without comment, so a build
    // that believed it had the extension and has not must stop here.
    const guard = build.steps.find(
      (step) => typeof step.run === 'string' && step.run.includes('would ship without one'),
    );
    expect(guard?.if).toContain("needs.extension.outputs.built == 'true'");
  });

  it('still packages when there is no extension at all', () => {
    // The supported empty state: every extension step is conditional, so a
    // checkout without `apps/extension` runs the matrix exactly as before.
    const conditioned = build.steps.filter(
      (step) => typeof step.if === 'string' && step.if.includes('extension.outputs.built'),
    );
    expect(conditioned).toHaveLength(2);
    const packaging = build.steps.find(
      (step) => typeof step.run === 'string' && step.run.includes('electron-builder'),
    );
    expect(packaging?.if).toBeUndefined();
  });
});
