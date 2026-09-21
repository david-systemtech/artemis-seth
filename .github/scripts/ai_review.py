"""Ask a cheap model to read the pull request, and leave one comment about it.

The comment is rewritten in place each time a review runs - when the pull
request opens, and again whenever someone adds the `ai-review` label - so a pull
request carries one review rather than a column of stale ones. It names the
commit it read, because it no longer tracks the head by itself. It ends with a
machine-readable block, because the second reader of this comment is Claude,
and a fenced JSON array is a contract where prose is a guess.

## Why this reads the diff from the API and not from the checkout

The workflow checks out the BASE commit, never the pull request's head. So
everything this script runs - itself, the rules it reads, the prompt - is code
that is already on the trunk and already reviewed, while the code under review
arrives as inert text through the API. That is what makes it safe to run under
`pull_request_target`, which a public repository needs: a pull request from a
fork gets no secrets under plain `pull_request`. See the workflow.

## Nothing in here is particular to one repository

What the project is (REVIEW_PROJECT), which files hold its rules
(REVIEW_RULES) and which paths are noise (REVIEW_SKIP) are the workflow's to
say, so a change to how the review works is a change to one file that any
repository using it can take as it is.

## The one model trap that cost an hour

GLM 5.3 Flash is a reasoning model and its thinking is billed and budgeted
against `max_tokens`. A tight budget returns `content: null` with a perfectly
healthy 200 - the tokens were spent before the answer began. Hence a wide
budget, and `finish_reason == "length"` treated as a failure worth retrying.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.request

MARKER = "<!-- glm-review -->"
OPENROUTER = "https://openrouter.ai/api/v1/chat/completions"

REPOSITORY = os.environ.get("GITHUB_REPOSITORY", "")
# How this job names itself to GitHub and OpenRouter: "artemis ai-review".
APP = f"{REPOSITORY.rsplit('/', 1)[-1] or 'repository'} ai-review"

# Roughly 100k tokens of diff. GLM 5.3 Flash holds 1.3M, so this cap is about
# money and attention, not capacity: past this size the review stops being a
# review and becomes a summary, and nobody reads those.
MAX_DIFF_CHARS = 400_000

# How many tokens one answer may use - reasoning included, because this model
# bills and budgets its thinking against `max_tokens`.
#
# A flat 32,000 is not enough: on 2026-09-18 a max-effort review of a 21 kB
# diff spent every one of them reasoning and never reached its answer - five
# minutes, nothing to show, and nothing a different provider could have done
# about it. How much this model thinks grows with how much it is shown - about
# a token a character on top of ten thousand - so the budget does too, with
# room to spare, up to a ceiling. The ceiling is on what the model WRITES, not
# its 1M context, which is what it can read: reasoning is output. 131,072 is
# the `max_completion_tokens` of Z.AI's own endpoint and of about half the
# others - it is not the model's limit. A dozen providers publish about
# 943,000 (checked 2026-09-19: CoreWeave, Crusoe, Together, Friendli,
# Fireworks...), and provider_order() already drops any endpoint that cannot
# emit the budget, so raising this would steer large reviews to those. It
# stays here by David's decision of that day: at a hundred tokens a second
# this many is already eighteen minutes, time is what runs out before tokens
# do, and nobody has measured whether a review that spent 131,072 on reasoning
# would have finished with more or only thought for longer.
TOKEN_BUDGET_FLOOR = 32_000
TOKEN_BUDGET_CEILING = 131_072


# At every effort, not only `max`. The `high` budget used to be the flat floor,
# on the belief that high reasons briefly; measured 2026-09-21 it does not on a
# large diff - 23,688 tokens written for a 70 kB diff, and a 73 kB one that
# spent all 32,000 on reasoning and never answered. Flat, that was invisible
# while each provider was stopped at a few minutes by the clock; once the
# answer was streamed and a working provider was let finish, it was the first
# thing a large review ran into.
def token_budget(effort: str, diff_chars: int) -> int:
    return int(min(max(16_000 + 2 * diff_chars, TOKEN_BUDGET_FLOOR), TOKEN_BUDGET_CEILING))


# The most a review will pay per token, as OpenRouter's `max_price` wants it:
# dollars per million. This is the model's standard rate, so nothing in the
# rotation is an outlier - one provider lists three times everyone else.
PRICE_CEILING = {"prompt": 0.15, "completion": 0.5}

# The slowest an endpoint may generate and still be a first choice. Below
# this a max-effort review (about 15,000 tokens of reasoning) takes longer
# than five minutes, which is longer than anyone waits for a pull request.
MIN_TOKENS_PER_S = 45

# When a provider is left for the next one.
#
# The ranking is made from OpenRouter's rolling medians, and a median is not a
# promise: on 2026-09-18 CoreWeave was published at 76 tokens a second, refused
# two requests and spent fifteen minutes producing nothing on a third, while
# BaseTen finished the same review in 93 seconds. So a provider is not trusted
# to finish - but it is not judged by a clock either.
#
# It used to be: each provider got half as long again as its published speed
# said the review would take. That needs to know how long the review will be,
# and nobody does. On 2026-09-21 a `high` review of a 70 kB diff was sized at
# 8,760 tokens and wrote about 19,000 (by its bill), so every provider was
# stopped by this script before it could have finished at its own published
# speed - together at 174 s, BaseTen at 186, Fireworks at 205, Wafer at 150 -
# and two reviews in a row posted nothing. The one that had succeeded did so
# only because Fireworks happened to run at twice its median. The estimate
# errs the other way at `max`: 118k expected for a 108 kB diff that wrote 35k.
#
# So the answer is streamed, and a provider is judged by what it is doing:
#
#  - It has not begun within FIRST_TOKEN_S. A request that sits in a queue
#    shows nothing, whatever the provider's median says.
#  - It went quiet for STALL_S mid-answer. The `: OPENROUTER PROCESSING`
#    comments the router sends while a request waits are not progress and do
#    not reset this.
#
# A provider that is producing is left to produce, for as long as the review's
# deadline allows. Its pace is logged, not judged: "can it finish in time at
# this rate" needs to know how much is left to write, which is the guess this
# replaced - and the first version had that rule, which reduces to a speed
# floor of expected tokens over deadline. At `max`, where the estimate runs
# three times high, it would have cut healthy providers a minute in. Until the
# estimates are fitted to the usage every review now logs, the deadline is the
# only judge of a slow provider.
FIRST_TOKEN_S = 120
STALL_S = 60

# How many attempts that actually *used* a provider - ran out its budget, or
# failed some other way. A refusal is not one of these: a 429 "rate-limited
# upstream" comes back in under a second and costs nothing but a log line.
# Counting refusals has a transcript: on 2026-09-18 the shared pools were
# saturated, ten refusals arrived inside a minute, a count of ten ran out with
# most of the deadline unspent, and a healthy pull request got no review. What
# bounds a review is its deadline.
MAX_ATTEMPTS = 4

# A refusal is a fact about that moment, not about the provider: BaseTen
# served one request and refused the next two minutes later. A fast provider
# that refuses is therefore asked again - after the other fast ones have had
# their turn, and no sooner than REFUSAL_WAITS_S after it refused. The waits
# grow with each refusal, because a saturated pool is waited out, not
# hammered; at two asks only the first is ever used, and the rest stay for
# whoever raises the count again. This many refusals before the slower tier is
# settled for.
#
# Two, not more. It was eight, to ride out a pool saturated for minutes; on
# 2026-09-18 CoreWeave, ranked first by its published speed, refused all 24
# requests of three reviews while BaseTen took each at its first ask, and
# waiting out eight refusals was five minutes of every ten-minute review. A
# provider still refusing after one retry is left for one that answers - and
# when every provider refuses, the review now says so within a minute.
#
# The wait belongs to the provider that refused, not to a count of refusals.
# Counted refusals decide badly when a provider drops out: the count still
# says "the whole fast tier just refused", so the first provider in the slower
# tier - which has refused nothing - waits a minute before anyone asks it.
REFUSALS_BEFORE_GIVING_UP = 2
REFUSAL_WAITS_S = (10, 20, 40, 60)

# Held back from a max-effort attempt so that, if it fails, there is still
# time for one quick pass at "high" - which takes well under a minute.
FALLBACK_RESERVE_S = 75

# How many tokens a review reasons for, by effort - for estimating its time
# and its bill, not for limiting it. Measured 2026-09-18: a max-effort review
# of 1.2 kB reasoned for 11,700 tokens; one of 21 kB passed 32,000.
REASONING_TOKENS = {"max": 10_500, "high": 2_000, "low": 600}
REASONING_TOKENS_PER_CHAR = {"max": 1.1, "high": 0.1, "low": 0.0}


# The share of the ceiling past which the effort asked for is not attempted.
# An estimate that close to everything the review may write is a review that
# will not reach its answer: it reasons until the tokens are gone, which at a
# hundred tokens a second is twenty minutes, and only then does the `high` pass
# that produces the comment begin. Measured: about 41,000 expected tokens
# finished (2026-09-18, a 28 kB diff, 335 s); about 83,000 did not (2026-09-19,
# a 66 kB diff: "all 131072 tokens went on reasoning", then no review at all,
# because the seventeen minutes it took left `high` nothing to work with).
NEAR_CEILING = 0.6


def expected_tokens(effort: str, diff_chars: int) -> int:
    """About how many tokens this review will generate - never more than it may."""
    base = REASONING_TOKENS.get(effort, REASONING_TOKENS["max"])
    per_char = REASONING_TOKENS_PER_CHAR.get(effort, REASONING_TOKENS_PER_CHAR["max"])
    return int(min(base + per_char * diff_chars, 0.9 * token_budget(effort, diff_chars)))


# Files whose diffs teach the model nothing and cost real tokens, in any
# repository. What is noise in one repository in particular - its design
# mockups, its release notes - the workflow names in REVIEW_SKIP, as glob
# patterns in which `*` crosses directories: `docs/design/*`.
SKIP_SUFFIXES = (
    "pnpm-lock.yaml",
    ".snap",
    ".min.js",
    ".min.css",
    ".ico",
    ".icns",
    ".png",
    ".jpg",
    ".svg",
    ".webp",
    ".woff",
    ".woff2",
)
SKIP_PATTERNS = tuple(os.environ.get("REVIEW_SKIP", "").split())


def is_noise(path: str) -> bool:
    return path.endswith(SKIP_SUFFIXES) or any(fnmatch.fnmatchcase(path, p) for p in SKIP_PATTERNS)


SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "findings"],
    "properties": {
        "summary": {
            "type": "string",
            "description": "One or two sentences on what this pull request does and its overall state.",
        },
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["file", "line", "severity", "category", "title", "detail", "confidence"],
                "properties": {
                    "file": {"type": "string", "description": "Repository-relative path from the diff."},
                    "line": {"type": "integer", "description": "Line in the new file; 0 if it does not apply."},
                    "severity": {"type": "string", "enum": ["blocker", "major", "minor", "nit"]},
                    "category": {
                        "type": "string",
                        "enum": ["correctness", "security", "tenancy", "contract", "performance", "style"],
                    },
                    "title": {"type": "string", "description": "Under 80 characters, the claim alone."},
                    "detail": {
                        "type": "string",
                        "description": "What breaks, with the concrete input or state that breaks it.",
                    },
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                },
            },
        },
    },
}

# What the project is, in a sentence or two, from the workflow.
PROJECT = (os.environ.get("REVIEW_PROJECT", "").strip() or REPOSITORY or "this repository").rstrip(".")

SYSTEM = f"""You review pull requests for {PROJECT}.

You are the first reader, not the last: a human and a stronger model both read
your findings afterwards. That makes a false positive expensive - it costs
another reader's attention - and silence cheap. Report what you can point at.

Rules:
- Report only defects you can locate in the diff you were given. Never report
  a problem in code you cannot see, and never guess at a file's other contents.
- The repository's own rules are below. A violation of those is a real finding,
  and is usually more valuable than a generic one.
- No praise, no summary of the change as a finding, no "consider adding tests"
  unless a specific untested branch is visibly risky.
- Style opinions are `nit` at most, and only when the repository is
  inconsistent as a result.
- An empty findings array is a good answer for a clean pull request. Say so in
  the summary and stop.
- `confidence: low` means you are reasoning about code you cannot fully see.
  Use it honestly; it is how the next reader decides what to re-check."""


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def gh_request(url: str, token: str, method: str = "GET", body: dict | None = None, accept: str | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", accept or "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", APP.replace(" ", "-"))
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read().decode()
    return raw if accept else json.loads(raw)


def filtered_diff(raw: str) -> tuple[str, int, int]:
    """Drop the files worth no tokens. Returns (diff, kept, skipped)."""
    chunks, current, keep = [], [], True
    kept = skipped = 0
    for line in raw.splitlines(keepends=True):
        if line.startswith("diff --git "):
            if current and keep:
                chunks.append("".join(current))
            current = [line]
            # "diff --git a/path b/path" - the b/ side survives renames better.
            parts = line.rsplit(" b/", 1)
            path = parts[1].strip() if len(parts) == 2 else ""
            keep = not is_noise(path)
            kept, skipped = (kept + 1, skipped) if keep else (kept, skipped + 1)
        else:
            current.append(line)
    if current and keep:
        chunks.append("".join(current))
    return "".join(chunks), kept, skipped


class AttemptTimeout(BaseException):
    """One provider used up its budget. The next one gets a turn.

    Not an Exception on purpose: the attempt loop catches
    Exception to move on after an *error*, and running out of time has to be
    told apart from that - it is caught by name, exactly once.
    """


class Stalled(Exception):
    """A provider stopped producing, never started, or is too slow to finish in time.

    Treated like AttemptTimeout - the provider is not asked again - but raised
    from the stream reader, which knows *why*, so the log can say.
    """


class Truncated(Exception):
    """The answer ran out of tokens before it began. Another provider would too."""


class OutOfTime(Exception):
    """This effort level has no time left to try in."""


# The whole review's clock. The timeout on the request is per socket read,
# and a provider that trickles keep-alive bytes resets it for ever: on 2026-09-18 a single request ran 25 minutes and was killed by the
# job's own timeout, which left a cancelled check on a healthy pull request -
# the one thing this script exists never to do. Nothing else here is a total
# deadline, so this is.
#
# It is sized to the work, like the token budget and for the same reason: a
# large diff at max effort is twenty minutes of generation on a good day, and
# a deadline that did not know that would abandon every such review. Three
# times what the review should take at a fast provider's pace, between a floor
# that leaves a small review room for a bad provider and a ceiling the
# workflow sets (REVIEW_DEADLINE_S) and must itself outlast.
STARTED = time.monotonic()
DEADLINE_FLOOR_S = 720
DEADLINE_CEILING_S = int(os.environ.get("REVIEW_DEADLINE_S", "2700"))
FAST_PROVIDER_TOKENS_PER_S = 80
DEADLINE = {"seconds": DEADLINE_FLOOR_S}


def size_deadline(tokens_out: int) -> None:
    wanted = 3 * tokens_out / FAST_PROVIDER_TOKENS_PER_S
    DEADLINE["seconds"] = int(min(max(wanted, DEADLINE_FLOOR_S), max(DEADLINE_CEILING_S, 60)))


def seconds_left() -> float:
    return DEADLINE["seconds"] - (time.monotonic() - STARTED)


def provider_order(api_key: str, model: str, prompt_chars: int, tokens_out: int, budget: int) -> list[dict]:
    """Rank the model's providers by how long THIS review would take, then by its bill.

    Price alone is the obvious ranking, and it is wrong in a way that costs a
    quarter of an hour a review. The cheapest endpoint for this model is also
    the slowest: measured 2026-09-18, DeepInfra's fp4 generated 17 tokens a
    second against 76 on BaseTen and CoreWeave at twice the price. A review at
    max effort reasons for about 15,000 tokens, so that is fourteen minutes
    against three - for a saving of $0.004 - and one review of a 6 kB diff,
    ranked by price, ran into a 25-minute job timeout having produced nothing.

    So: endpoints fast enough come first, cheapest among them first; the slow
    ones follow as fallbacks, fastest first. The speed is OpenRouter's own
    rolling median (`throughput_last_30m.p50`), which the endpoints list only
    includes for an authenticated caller - hence the key.

    OpenRouter's own sorting cannot do this. `sort: "price"` was measured not
    to pick the cheapest (it ranked a provider at 3x the going rate second),
    and an explicit `order` is what the router does honour: first choice
    first, then down the list on an outage.

    Only endpoints that enforce a strict JSON schema qualify. Z.AI and Novita,
    among others, accept `response_format` but not `structured_outputs`.
    """
    req = urllib.request.Request(f"https://openrouter.ai/api/v1/models/{model}/endpoints")
    req.add_header("Authorization", f"Bearer {api_key}")
    with urllib.request.urlopen(req, timeout=30) as resp:
        endpoints = json.loads(resp.read().decode())["data"]["endpoints"]
    tokens_in = prompt_chars / 4
    candidates = []
    for e in endpoints:
        if "structured_outputs" not in (e.get("supported_parameters") or []):
            continue
        # An endpoint that cannot emit the budget would truncate the answer
        # this review was sized for, however fast it is.
        if (e.get("max_completion_tokens") or 0) < budget:
            continue
        price = e.get("pricing") or {}
        # Priced per token here, per million in the ceiling. An endpoint over
        # it would only be refused by the router, a request at a time.
        if (
            float(price.get("prompt", 0)) * 1e6 > PRICE_CEILING["prompt"] + 1e-9
            or float(price.get("completion", 0)) * 1e6 > PRICE_CEILING["completion"] + 1e-9
        ):
            continue
        cost = float(price.get("prompt", 0)) * tokens_in + float(price.get("completion", 0)) * tokens_out
        stats = e.get("throughput_last_30m")
        speed = float(stats["p50"]) if isinstance(stats, dict) and stats.get("p50") else 0.0
        candidates.append({"tag": e["tag"], "cost": cost, "speed": speed})
    fast = sorted((c for c in candidates if c["speed"] >= MIN_TOKENS_PER_S), key=lambda c: (c["cost"], -c["speed"]))
    slow = sorted((c for c in candidates if c["speed"] < MIN_TOKENS_PER_S), key=lambda c: (-c["speed"], c["cost"]))
    # A provider can list two endpoints under one tag; the router wants each
    # once, and it should stand where its *best* endpoint ranked. (Not a dict
    # built from the reversed list, which is the shorter way to write it: that
    # keeps a key's first position and its last value, so a provider with a
    # fast endpoint and a slow one is filed where the slow one ranked, wearing
    # the fast one's numbers. This script found that, reviewing itself.)
    seen: set[str] = set()
    ranked = []
    for c in fast + slow:
        if c["tag"] not in seen:
            seen.add(c["tag"])
            ranked.append(c)
    log(
        "provider order: "
        + ", ".join(
            f"{c['tag']} ({c['speed']:.0f} tok/s, ${c['cost']:.4f}, ~{tokens_out / c['speed'] / 60:.1f} min)"
            if c["speed"]
            else f"{c['tag']} (speed unknown, ${c['cost']:.4f})"
            for c in ranked[:5]
        )
    )
    return ranked


def call_model(api_key: str, model: str, prompt: str, diff_chars: int) -> tuple[dict, str, str]:
    """The review, the effort that produced it, and a note when that was not the one asked for.

    The effort asked for is tried in earnest - budget, deadline and providers
    all sized to it. Only when it cannot finish (its tokens ran out, its time
    did, or nobody would serve it) is there one quick pass at "high", because
    a pull request with a shallower review is better served than one with
    none, and the comment says which it got.
    """
    wanted = os.environ.get("REVIEW_EFFORT", "max")
    expected = expected_tokens(wanted, diff_chars)
    if wanted != "high" and expected > NEAR_CEILING * TOKEN_BUDGET_CEILING:
        log(f"effort {wanted}: about {expected} tokens expected of the {TOKEN_BUDGET_CEILING} it may write; straight to high")
        size_deadline(expected_tokens("high", diff_chars))
        result = run_effort(api_key, model, prompt, diff_chars, "high", 0)
        return result, "high", (
            f"This diff is too large for a `{wanted}`-effort review to finish inside the "
            f"{TOKEN_BUDGET_CEILING:,} tokens a review may write, so this is a `high` pass."
        )
    size_deadline(expected)
    log(
        f"effort {wanted}: up to {token_budget(wanted, diff_chars)} tokens, "
        f"about {expected_tokens(wanted, diff_chars)} expected, {DEADLINE['seconds']} s in all"
    )
    try:
        reserve = FALLBACK_RESERVE_S if wanted != "high" else 0
        return run_effort(api_key, model, prompt, diff_chars, wanted, reserve), wanted, ""
    except (Truncated, OutOfTime, RuntimeError) as exc:
        if wanted == "high" or seconds_left() < 30:
            raise
        why = str(exc)
        log(f"effort {wanted} did not finish ({why}); one pass at high instead")
        result = run_effort(api_key, model, prompt, diff_chars, "high", 0)
        return result, "high", f"A `{wanted}`-effort review did not finish ({why}), so this is a quicker `high` pass."


def read_stream(resp) -> dict:
    """Read a streamed answer into the shape an unstreamed one has, judging the provider as it goes.

    What the router sends, measured 2026-09-21 on this model: `data:` chunks
    whose delta carries `reasoning` or `content`, about one token each; `:`
    comment lines while a request waits, which are not progress; and `usage`,
    exact token counts included, on the last chunk without being asked for.

    Progress is counted as the larger of chunks and characters over four. A
    provider is not obliged to send one token a chunk, and counting chunks
    alone would make one that batches look slow - which is the thing that gets
    a provider cut. The exact count arrives in `usage` at the end.
    """
    started = time.monotonic()
    first_at: float | None = None
    last_at = started
    chunks = chars = 0
    content: list[str] = []
    finish = usage = provider = None
    try:
        for raw in resp:
            now = time.monotonic()
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if line.startswith("data: ") and line != "data: [DONE]":
                chunk = json.loads(line[6:])
                if chunk.get("error"):
                    raise RuntimeError(f"the stream reported an error: {json.dumps(chunk['error'])[:300]}")
                provider = chunk.get("provider") or provider
                usage = chunk.get("usage") or usage
                for choice in chunk.get("choices") or []:
                    delta = choice.get("delta") or {}
                    text = (delta.get("reasoning") or "") + (delta.get("content") or "")
                    if text:
                        chunks += 1
                        chars += len(text)
                        last_at = now
                        first_at = first_at or now
                    if delta.get("content"):
                        content.append(delta["content"])
                    finish = choice.get("finish_reason") or finish
            # Judged on every line, comments included: they are what keep this
            # loop turning while nothing else arrives.
            tokens = max(chunks, chars // 4)
            if first_at is None:
                if now - started > FIRST_TOKEN_S:
                    raise Stalled(f"had not begun after {FIRST_TOKEN_S} s")
            elif now - last_at > STALL_S:
                raise Stalled(f"went quiet for {STALL_S} s after about {tokens} tokens")
    except TimeoutError as exc:
        # The per-read timeout: not a byte, not even a keep-alive - before the
        # answer began or part-way through it, which the log has to tell apart.
        if first_at is None:
            raise Stalled(f"sent nothing at all for {STALL_S} s") from exc
        raise Stalled(f"went silent for {STALL_S} s after about {max(chunks, chars // 4)} tokens") from exc
    if finish is None:
        raise RuntimeError("the stream ended without finishing an answer")
    return {
        "choices": [{"finish_reason": finish, "message": {"content": "".join(content) or None}}],
        "usage": usage or {},
        "provider": provider,
        "elapsed": time.monotonic() - started,
        "generating": time.monotonic() - (first_at or started),
    }


def run_effort(api_key: str, model: str, prompt: str, diff_chars: int, effort: str, reserve: float) -> dict:
    budget_tokens = token_budget(effort, diff_chars)
    tokens_out = expected_tokens(effort, diff_chars)
    try:
        queue = provider_order(api_key, model, len(prompt), tokens_out, budget_tokens)
    except Exception as exc:  # noqa: BLE001 - a ranking failure must not cost the review
        log(f"could not rank providers ({exc}); falling back to the ones measured fast")
        queue = [{"tag": tag, "speed": 60.0, "cost": 0.0} for tag in ("baseten", "coreweave", "fireworks")]
    payload = {
        "model": model,
        # Streamed so that a provider is judged by what it is doing rather
        # than by a guess at how long the review will be - see FIRST_TOKEN_S.
        "stream": True,
        "temperature": 0,
        # Wide on purpose: reasoning tokens are drawn from this budget, and a
        # truncated answer is indistinguishable from a healthy empty one.
        "max_tokens": budget_tokens,
        # This model accepts only "max", "high" and "low" - its entry in the
        # models API lists them. "medium" is not among them, and a request for
        # it gets whatever the provider decides, which was next to no reasoning
        # at all. Measured 2026-09-18 on a fixture with ten planted bugs: every
        # level found the obvious and rule-based ones, but only runs that
        # reasoned 7k+ tokens found the two that needed real thought - 6 of 8
        # at max, 1 of 6 at high. What max costs is time, and how much depends
        # on the provider far more than on the diff - see provider_order.
        # REVIEW_EFFORT picks.
        "reasoning": {"effort": effort},
        # "provider" is set per attempt, below: one named endpoint at a time,
        # with no fallbacks, so that when it is slow this script is the one
        # that decides to leave rather than the router deciding to stay.
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "review", "strict": True, "schema": SCHEMA},
        },
    }
    last = "no attempt made"
    # The top tier: within a quarter of the fastest on offer. A refusal from
    # one of these is worth waiting out, because the alternative is a provider
    # that takes half as long again - so they are asked again, in turn, before
    # anything slower is settled for.
    top_speed = max((c["speed"] for c in queue), default=0.0)

    def top_tier(c: dict) -> bool:
        return top_speed > 0 and c["speed"] >= 0.75 * top_speed

    refusals: dict[str, int] = {}
    # When each provider that refused may be asked again, on the review's clock.
    asked_again_at: dict[str, float] = {}
    attempt = 0  # every request, for the log
    used = 0  # the ones that cost a provider's time - what MAX_ATTEMPTS bounds
    while queue and used < MAX_ATTEMPTS:
        candidate = queue.pop(0)
        tag = candidate["tag"]
        attempt += 1
        if tag in asked_again_at:
            # Only what is left of its wait - the other fast providers' turns
            # have used some of it - and never into the time held back for the
            # fallback.
            wait = min(asked_again_at[tag] - time.monotonic(), seconds_left() - reserve - 60)
            if wait > 0:
                log(f"{tag} has refused {refusals[tag]} time(s); asking it again in {wait:.0f} s")
                time.sleep(wait)
        # What is left of the review's clock is this provider's to use, so
        # long as it keeps producing - read_stream decides when it has not.
        budget = int(seconds_left() - reserve)
        if budget < 10:
            signal.alarm(0)
            raise OutOfTime(f"no time left for another provider; last: {last}")
        log(f"attempt {attempt}: {tag}, streamed, up to {budget} s")
        payload["provider"] = {
            "order": [tag],
            "allow_fallbacks": False,
            "require_parameters": True,
            "max_price": PRICE_CEILING,
        }
        signal.alarm(budget)
        try:
            req = urllib.request.Request(OPENROUTER, data=json.dumps(payload).encode(), method="POST")
            req.add_header("Authorization", f"Bearer {api_key}")
            req.add_header("Content-Type", "application/json")
            # OpenRouter attributes the traffic with these; they are how this
            # job shows up as itself on the usage page.
            req.add_header("HTTP-Referer", f"https://github.com/{REPOSITORY}")
            req.add_header("X-OpenRouter-Title", APP)
            req.add_header("X-OpenRouter-Metadata", "enabled")
            with urllib.request.urlopen(req, timeout=STALL_S) as resp:
                body = read_stream(resp)
            choice = body["choices"][0]
            if choice.get("finish_reason") == "length":
                # Not a provider's fault and not worth another provider: how
                # much this model reasons is a property of what it was shown.
                signal.alarm(0)
                raise Truncated(f"all {budget_tokens} tokens went on reasoning")
            content = choice["message"].get("content")
            if not content:
                raise ValueError("model returned empty content")
            # Structured output is a request, not a guarantee: providers
            # occasionally wrap the object in a fence. Observed on the very
            # first live run, attempt 1.
            text = content.strip()
            if text.startswith("```"):
                text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
                text = re.sub(r"\n?```$", "", text.strip())
            parsed = json.loads(text)
            usage = body["usage"]
            written = usage.get("completion_tokens") or 0
            reasoned = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens")
            signal.alarm(0)
            # The real counts, against the estimate the budgets were sized
            # from: the data the estimates in this file should be fitted to.
            log(
                f"model ok (attempt {attempt} on {tag}, served by {body.get('provider')}): "
                f"{written} tokens written ({reasoned} reasoning) against {tokens_out} expected, "
                f"prompt {usage.get('prompt_tokens')}, {body['elapsed']:.0f} s in all, "
                f"{written / max(body['generating'], 1):.0f} tok/s, cost ${usage.get('cost')}"
            )
            return parsed
        except Truncated:
            raise
        except Stalled as exc:
            signal.alarm(0)
            used += 1
            # Not asked again: what it could not do once it will not do twice.
            last = f"{tag} {exc}"
            log(f"attempt {attempt} abandoned: {last}")
            continue
        except AttemptTimeout:
            used += 1
            # Not asked again: what it was slow at once it will be slow at twice.
            last = f"{tag} had not answered after {budget} s"
            log(f"attempt {attempt} abandoned: {last}")
            continue
        except Exception as exc:  # noqa: BLE001 - every failure here moves on the same way
            signal.alarm(0)
            last = f"{type(exc).__name__}: {exc}"
            if isinstance(exc, urllib.error.HTTPError):
                last += f" - {exc.read().decode()[:400]}"
            log(f"attempt {attempt} on {tag} failed: {last}")
            refused = isinstance(exc, urllib.error.HTTPError) and exc.code == 429
            if not refused:
                used += 1
            if refused and top_tier(candidate):
                refusals[tag] = refusals.get(tag, 0) + 1
                if refusals[tag] < REFUSALS_BEFORE_GIVING_UP:
                    pause = REFUSAL_WAITS_S[min(refusals[tag], len(REFUSAL_WAITS_S)) - 1]
                    asked_again_at[tag] = time.monotonic() + pause
                    # Back in line behind the rest of the top tier, ahead of
                    # everyone slower - by position, not by count: the tier
                    # is not promised to sit together at the front.
                    last_top = max((i for i, c in enumerate(queue) if top_tier(c)), default=-1)
                    queue.insert(last_top + 1, candidate)
            # The next attempt is usually a different provider, so there is
            # nothing to wait out - only a beat, in case the fault was ours.
            time.sleep(2)
    signal.alarm(0)
    raise RuntimeError(f"no provider produced a review; last: {last}")


SEVERITY_ORDER = {"blocker": 0, "major": 1, "minor": 2, "nit": 3}
SEVERITY_ICON = {"blocker": "🛑", "major": "🔸", "minor": "🔹", "nit": "·"}


def fence_for(text: str) -> str:
    """A code fence longer than any run of backticks in the text, so nothing inside can end it."""
    return "`" * max(3, len(max(re.findall(r"`+", text) or [""], key=len)) + 1)


def render(result: dict, model: str, sha: str, skipped: int, truncated: bool, effort: str, note: str) -> str:
    # The schema is a request, not a guarantee (see run_effort), and by now the
    # review has been paid for. A finding that bends it - a severity outside the
    # enum, a field left out - is shown as it came rather than costing the rest.
    findings = sorted(
        (f for f in result.get("findings") or [] if isinstance(f, dict)),
        key=lambda f: (SEVERITY_ORDER.get(f.get("severity"), 9), str(f.get("file", ""))),
    )
    lines = [
        MARKER,
        f"### 🤖 Automated review — `{model}` · effort `{effort}`",
        "",
        *([f"> {note}", ""] if note else []),
        str(result.get("summary") or "").strip(),
        "",
    ]
    if findings:
        counts: dict = {}
        for f in findings:
            counts[f.get("severity", "?")] = counts.get(f.get("severity", "?"), 0) + 1
        tally = ", ".join(
            f"{n} {sev}" for sev, n in sorted(counts.items(), key=lambda kv: SEVERITY_ORDER.get(kv[0], 9))
        )
        lines += [f"**{len(findings)} finding(s):** {tally}", ""]
        for f in findings:
            icon = SEVERITY_ICON.get(f.get("severity"), "·")
            where = f"`{f.get('file', '?')}`" + (f":{f['line']}" if f.get("line") else "")
            conf = "" if f.get("confidence") == "high" else f" _({f.get('confidence', '?')} confidence)_"
            title, category = f.get("title", "(untitled)"), f.get("category", "?")
            lines += [f"{icon} **{title}** — {where} · {category}{conf}", "", f"  {f.get('detail', '')}", ""]
    else:
        lines += ["No findings. ✅", ""]
    # The findings are the model's words, and the model quotes code. A finding
    # that contains a fence would end this one early and hand the next reader a
    # truncated array - so the fence is always longer than anything inside it.
    payload = json.dumps(findings, indent=2)
    fence = fence_for(payload)
    lines += [
        "<details><summary>Findings as JSON (for the next reviewer)</summary>",
        "",
        f"{fence}json",
        payload,
        fence,
        "",
        "</details>",
        "",
        f"<sub>Reviewed `{sha[:7]}`"
        + (f" · {skipped} file(s) skipped as noise" if skipped else "")
        + (" · **diff truncated — the tail was not reviewed**" if truncated else "")
        + ". Pushes do not re-run it: add the `ai-review` label for another pass, "
        + "which replaces this comment. "
        + "A finding is a lead, not a verdict.</sub>",
    ]
    return "\n".join(lines)


# Whose marked comment a review rewrites. On a public repository anyone can
# post a comment carrying the marker - it renders as nothing - and the review
# must not land in a stranger's comment, or leave the real one standing stale
# behind it. A run by hand, under a person's token, posts a comment of its own.
BOT = "github-actions[bot]"


def upsert_comment(repo: str, number: str, token: str, body: str) -> None:
    page = 1
    existing = None
    while True:
        batch = gh_request(
            f"https://api.github.com/repos/{repo}/issues/{number}/comments?per_page=100&page={page}", token
        )
        if not batch:
            break
        for c in batch:
            if MARKER in (c.get("body") or "") and (c.get("user") or {}).get("login") == BOT:
                existing = c["id"]
        if len(batch) < 100:
            break
        page += 1
    if existing:
        gh_request(f"https://api.github.com/repos/{repo}/issues/comments/{existing}", token, "PATCH", {"body": body})
        log(f"updated comment {existing}")
    else:
        gh_request(f"https://api.github.com/repos/{repo}/issues/{number}/comments", token, "POST", {"body": body})
        log("posted a new comment")


class NoReview(Exception):
    """Nothing can be reviewed, for a reason the pull request should be told in these words."""


# What a failed review needs in order to say so on the pull request.
CONTEXT: dict = {}


def main() -> int:
    repo = os.environ["GITHUB_REPOSITORY"]
    number = os.environ["PR_NUMBER"]
    gh_token = os.environ["GITHUB_TOKEN"]
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    model = os.environ.get("REVIEW_MODEL", "z-ai/glm-5.3-flash")
    if not api_key:
        # The repository has no such secret, or this run was not given it
        # (Dependabot's are not). That is configuration, not a failed review,
        # and a note saying so on every pull request would be noise.
        log("OPENROUTER_API_KEY is empty - no review attempted")
        return 0
    # Before anything that can fail, so that a failure to even *read* the pull
    # request is said on it. The head is filled in once it is known.
    CONTEXT.update(repo=repo, number=number, token=gh_token, model=model, sha=None)

    pr = gh_request(f"https://api.github.com/repos/{repo}/pulls/{number}", gh_token)
    CONTEXT["sha"] = pr["head"]["sha"]
    try:
        raw = gh_request(
            f"https://api.github.com/repos/{repo}/pulls/{number}",
            gh_token,
            accept="application/vnd.github.v3.diff",
        )
    except urllib.error.HTTPError as exc:
        if exc.code != 406:
            raise
        # GitHub's answer to a diff past 20,000 lines - #380 here was 43,000.
        raise NoReview("GitHub will not produce a diff this large - over 20,000 lines - to read.") from exc
    diff, kept, skipped = filtered_diff(raw)
    log(f"diff: {len(raw)} chars raw, {len(diff)} kept, {kept} file(s), {skipped} skipped")
    if not diff.strip():
        log("nothing reviewable - leaving the pull request alone")
        return 0

    truncated = len(diff) > MAX_DIFF_CHARS
    if truncated:
        diff = diff[:MAX_DIFF_CHARS] + "\n\n[diff truncated at the size cap]\n"

    # Read from the checkout, which is the base commit: a pull request does not
    # get to rewrite the rules it is judged by.
    rules = []
    for name in os.environ.get("REVIEW_RULES", "AGENTS.md").split():
        try:
            with open(name, encoding="utf-8") as f:
                rules.append(f"## {name}\n\n{f.read().strip()}")
        except OSError:
            log(f"no {name} on the base branch - reviewing without it")
    rulebook = "\n\n".join(rules) or "(none found)"

    # A diff of a markdown file carries that file's own fences, and one of them
    # on a context line would close a plain ``` early, leaving the rest of the
    # diff - and the instruction after it - as loose text.
    fence = fence_for(diff)
    prompt = (
        f"# The repository's rules (from the base branch)\n\n{rulebook}\n\n"
        f"# Pull request #{number}: {pr.get('title', '')}\n\n"
        f"{(pr.get('body') or '(no description)')[:4000]}\n\n"
        f"# The diff\n\n{fence}diff\n{diff}\n{fence}\n\n"
        "Review it. Report only defects you can point at in this diff."
    )

    result, effort, note = call_model(api_key, model, prompt, len(diff))
    body = render(result, model, pr["head"]["sha"], skipped, truncated, effort, note)
    upsert_comment(repo, number, gh_token, body)
    return 0


def say_no_review(why: str) -> None:
    """Replace the comment with the truth: this commit has no review.

    The comment always describes the head it names. Leaving an older commit's
    findings in place would present them as this one's, and leaving a clean
    result in place would present silence as approval. No JSON block, so the
    next reader finds nothing to parse rather than an empty list to trust.
    """
    if not CONTEXT:
        return
    head = f"`{CONTEXT['sha'][:7]}`" if CONTEXT.get("sha") else "the current head"
    body = "\n".join(
        [
            MARKER,
            f"### 🤖 Automated review — `{CONTEXT['model']}`",
            "",
            f"**No review for {head}.** {why} This is not an approval.",
            "",
            "<sub>Pushes do not re-run it: add the `ai-review` label to try again.</sub>",
        ]
    )
    upsert_comment(CONTEXT["repo"], CONTEXT["number"], CONTEXT["token"], body)


if __name__ == "__main__":

    def _attempt_out_of_time(_signum, _frame):
        raise AttemptTimeout()

    signal.signal(signal.SIGALRM, _attempt_out_of_time)
    try:
        sys.exit(main())
    except (OutOfTime, AttemptTimeout) as exc:
        signal.alarm(0)
        log(f"ai-review abandoned after {DEADLINE['seconds']} s: {exc}")
        why = f"No provider had produced one after {DEADLINE['seconds'] / 60:.0f} minutes, so it was abandoned."
    except NoReview as exc:
        log(f"ai-review had nothing to review: {exc}")
        why = str(exc)
    except Exception as exc:  # noqa: BLE001
        # A failed review must never fail the pull request. A red X that means
        # "the robot was rate limited" teaches people to ignore red Xs, and the
        # next red X is a real one.
        signal.alarm(0)
        log(f"ai-review did not complete: {type(exc).__name__}: {exc}")
        why = "The review failed before it produced anything; the job log says how."
    try:
        say_no_review(why)
    except Exception as exc:  # noqa: BLE001
        log(f"could not say so on the pull request: {type(exc).__name__}: {exc}")
    sys.exit(0)
