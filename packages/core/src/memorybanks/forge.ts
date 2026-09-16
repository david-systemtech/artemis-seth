/**
 * The forge behind a bank's remote: opening, merging and checking pull
 * requests over its API.
 *
 * Two forges are known, and they are told apart by the remote URL: a GitHub
 * host uses the GitHub REST API, anything else is asked as Gitea, which is
 * what Forgejo speaks. The `cerebro` CLI could only land through the GitHub
 * CLI, so on a Forgejo origin — cortex's — a promote ended as "pushed a
 * branch, open a pull request by hand", and an agent finished the job by
 * following a memory. This is that job, done by the host.
 *
 * Nothing here holds a credential. The caller resolves one — the bank's stored
 * token, a key-manager reference, or what `git credential fill` answers for the
 * host — and passes it in for the calls that need it.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ForgeKind = 'github' | 'gitea';

export interface Forge {
  readonly kind: ForgeKind;
  /** `https://api.github.com` or `https://forge.example/api/v1`. */
  readonly apiBase: string;
  /** The host the credential is for: `github.com`, `100.109.204.54:8300`. */
  readonly host: string;
  readonly scheme: 'https' | 'http';
  readonly owner: string;
  readonly repo: string;
}

/**
 * Read a forge off a remote URL. `null` for a remote no API can be guessed
 * for: a local path, an ssh alias that names no host, an unparseable string.
 */
export function detectForge(remote: string): Forge | null {
  const trimmed = remote.trim();
  let host: string;
  let path: string;
  let scheme: 'https' | 'http' = 'https';
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):([^/\s].*)$/.exec(trimmed);
  const url = /^(https?|ssh|git):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(trimmed);
  if (url !== null) {
    scheme = url[1] === 'http' ? 'http' : 'https';
    host = url[2] ?? '';
    path = url[3] ?? '';
  } else if (scp !== null && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    host = scp[1] ?? '';
    path = scp[2] ?? '';
  } else {
    return null;
  }
  const parts = path.replace(/\.git\/?$/, '').replace(/\/+$/, '').split('/').filter((part) => part.length > 0);
  if (parts.length < 2 || host.length === 0) return null;
  const owner = parts[parts.length - 2] ?? '';
  const repo = parts[parts.length - 1] ?? '';
  if (owner.length === 0 || repo.length === 0) return null;
  const bareHost = host.replace(/^ssh\./, '');
  if (/(^|\.)github\.com$/i.test(bareHost)) {
    return { kind: 'github', apiBase: 'https://api.github.com', host: 'github.com', scheme: 'https', owner, repo };
  }
  return { kind: 'gitea', apiBase: `${scheme}://${host}/api/v1`, host, scheme, owner, repo };
}

export interface ForgeCredential {
  readonly username: string;
  readonly token: string;
}

/**
 * What git itself would present for a host, from its credential helpers.
 *
 * The fallback when Artemis holds nothing for the bank: a machine whose git
 * already pushes to the forge has a credential somewhere, and this is how git
 * reads it. `null` when no helper answers.
 */
export async function gitCredentialFill(forge: Forge): Promise<ForgeCredential | null> {
  try {
    // `credential fill` reads its request from stdin, which `execFile` cannot
    // feed; the synchronous form can, and fifteen seconds bounded is fine for
    // a helper that answers from a store or not at all.
    const stdout = await Promise.resolve().then(() =>
      execFileSync('git', ['credential', 'fill'], {
        input: `protocol=${forge.scheme}\nhost=${forge.host}\n\n`,
        timeout: 15_000,
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['pipe', 'pipe', 'ignore'],
      }),
    );
    const fields = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1).trim());
    }
    const username = fields.get('username');
    const token = fields.get('password');
    if (username === undefined || token === undefined || token.length === 0) return null;
    return { username, token };
  } catch {
    return null;
  }
}

function headersFor(forge: Forge, credential: ForgeCredential | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: forge.kind === 'github' ? 'application/vnd.github+json' : 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'artemis-memory-banks',
  };
  if (credential !== null) {
    headers['Authorization'] = forge.kind === 'github' ? `Bearer ${credential.token}` : `token ${credential.token}`;
  }
  return headers;
}

async function call(
  forge: Forge,
  credential: ForgeCredential | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${forge.apiBase}${path}`, {
    method,
    headers: headersFor(forge, credential),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

export interface PullRequest {
  readonly number: number;
  readonly url: string;
}

/** Open a pull request from `head` into `base`. Throws with the forge's words on failure. */
export async function openPullRequest(
  forge: Forge,
  credential: ForgeCredential | null,
  input: { readonly head: string; readonly base: string; readonly title: string; readonly body: string },
): Promise<PullRequest> {
  const { status, json } = await call(forge, credential, 'POST', `/repos/${forge.owner}/${forge.repo}/pulls`, input);
  const record = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  if (status < 200 || status >= 300 || typeof record['number'] !== 'number') {
    throw new Error(`${forge.kind} refused the pull request (${String(status)}): ${describeError(record)}`);
  }
  return { number: record['number'], url: typeof record['html_url'] === 'string' ? record['html_url'] : '' };
}

function describeError(record: Record<string, unknown>): string {
  const message = record['message'];
  if (typeof message === 'string' && message.length > 0) return message;
  const errors = record['errors'];
  if (Array.isArray(errors) && errors.length > 0) return JSON.stringify(errors[0]);
  return 'no reason given';
}

/**
 * Merge a pull request, retrying the "try again later" a forge answers while
 * it recomputes mergeability after the base moved. `false` when the forge
 * keeps refusing — the pull request stays open for a person.
 */
export async function mergePullRequest(
  forge: Forge,
  credential: ForgeCredential | null,
  number: number,
  options: { readonly attempts?: number; readonly delayMs?: number; readonly method?: 'merge' | 'squash' } = {},
): Promise<{ merged: boolean; detail: string }> {
  const attempts = options.attempts ?? 6;
  const delay = options.delayMs ?? 3000;
  const method = options.method ?? 'merge';
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { status, json } =
      forge.kind === 'github'
        ? await call(forge, credential, 'PUT', `/repos/${forge.owner}/${forge.repo}/pulls/${String(number)}/merge`, { merge_method: method })
        : await call(forge, credential, 'POST', `/repos/${forge.owner}/${forge.repo}/pulls/${String(number)}/merge`, { Do: method });
    if (status >= 200 && status < 300) return { merged: true, detail: `merged as ${method}` };
    const record = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
    last = `${String(status)}: ${describeError(record)}`;
    // 405 is both forges' "not yet": GitHub while a required check runs, Forgejo
    // while it recomputes mergeability. Anything else is a real refusal.
    if (status !== 405 && status !== 409) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return { merged: false, detail: last };
}

/** Does the file exist on the branch, as the forge sees it now? */
export async function fileOnBranch(
  forge: Forge,
  credential: ForgeCredential | null,
  path: string,
  branch: string,
): Promise<boolean> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const { status } = await call(
    forge,
    credential,
    'GET',
    `/repos/${forge.owner}/${forge.repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`,
  );
  return status === 200;
}

/**
 * The remote's default branch as the checkout knows it, `main` when the
 * checkout has never recorded one.
 */
export async function defaultBranch(root: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    const name = stdout.trim().replace(/^origin\//, '');
    if (name.length > 0) return name;
  } catch {
    // Not recorded; fall through.
  }
  return 'main';
}
