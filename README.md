# CF-Bench

A small benchmark of realistic Cloudflare administration tasks for computer-use agents.

Each task breaks a real Cloudflare zone in a specific way, hands an attempt a support
ticket describing only the symptom, and then grades the result by reading the live
configuration and making real HTTP requests to the site. Humans and agents receive the
same ticket, start from the same reset state, and are scored by the same code.

Six tasks, 33 checks, 63 unit tests. Every task has been verified end to end against a
real zone: seed → grade (fail) → apply a known-good fix → grade (pass) → reset.

---

## The argument

Most agent evaluations grade what the agent *said*. This one grades what changed.

The distinction is not academic. Early in development, an agent read ticket #4417 and
produced a genuinely excellent 2,000-word incident report: correct root cause (Flexible
SSL causing a redirect loop), correct fix (Full (strict)), and an unprompted warning that
flipping the mode before the origin certificate is ready yields a 525 instead. It
declared `success: true`.

It never opened a browser. The site was still down.

**CF-Bench scored it 0/5.** An evaluation that graded the response would have scored it
near the top. The only thing separating those two verdicts is whether anybody checked the
site.

That is the entire thesis, and it arrived by accident rather than by construction.

### Grading the outcome, not the method

A grader that compares configuration against one expected answer measures conformity, not
correctness. Task 03 asks for `/admin` to be blocked except from one address. On
Cloudflare's Free plan there is no regex, and all of these are correct:

```
(http.request.uri.path eq "/admin" or starts_with(http.request.uri.path, "/admin/")) and ip.src ne X
not (ip.src eq X) and http.request.uri.path wildcard "/admin*"
ip.src ne X and starts_with(http.request.uri.path, "/admin")
```

The grader accepts all three because it never reads them. It requests `/admin` and expects
403, requests `/admin/settings` and expects 403, requests `/` and expects 200. A
hand-written rule the code had never seen passes 5/5; a rule that blocks only the exact
path `/admin` fails, caught by a live request to `/admin/settings` rather than by
inspecting syntax.

Configuration is read only where behaviour cannot settle the question. Blocking `/admin`
for *everyone* is behaviourally identical, at every URL the grader can reach, to a correct
fix with an exception — while locking the ops team out, which the ticket forbids. The
grader cannot make a request from the office address, so that one fact is read rather than
observed, and the tradeoff is documented where it occurs.

### Resets are the other half

A benchmark is only comparable if every attempt starts from the same place. `reset()` is
written as a convergence rather than a sequence of mutations: it states the desired state
unconditionally, so running it once or five times leaves the zone identical.

Two problems surfaced only by running against real infrastructure:

**Tasks contaminated each other.** All six share one zone, so seeding task 03 while task 01
sat broken failed task 03's grader for an unrelated reason, and results depended on
execution order. Every task now seeds a healthy zone-wide baseline first, then breaks the
one dimension it owns.

**Seeding is asynchronous.** Writing a Cloudflare setting and that setting taking effect at
the edge are separate events, seconds apart. Task 05 graded as PASS immediately after
seeding, because the cache rule had not propagated — which in the agent flow would let an
attempt score a pass on a task that was never broken. `seedAndConfirm` now blocks until the
breakage is observable, not merely written.

---

## Results

Runs against the live zone, `browser-use` driving a real Chrome window via
`openai/gpt-5.1`:

| Task | Faults | Result | Steps |
| --- | --- | --- | --- |
| 01 ssl-redirect-loop | 1 | **PASS 5/5** | 9 |
| 02 access-staging-lockdown | 1 | **PASS 6/6** | 16 |
| 06 api-migration-incident | 4 | **FAIL 7/9** | 77 |
| 06 api-migration-incident *(re-run)* | 4 | **PASS 9/9** | 42 |
| 01 ssl-redirect-loop *(early)* | 1 | **FAIL 0/5** | 1 |

The last row is the report-without-acting case described above.

The two task 06 rows are worth more than either alone. The first attempt fixed DNS, TLS
and caching, then ran out of step budget mid-way through the WAF rule and stopped at 95%.
It reported, accurately, which requirement it had not met.

Re-running it after raising the step budget **and** fixing a defect in the ticket — which
had named the same IP address as both the production origin and the office address —
produced 9/9 in half the steps.

So the benchmark's own bug was part of what it measured. A single run would have reported
"this agent cannot compose WAF expressions," which was false. That is an argument for
treating an eval as software that needs its own debugging, not as a ruler.

---

## How a run works

```
1. RESET     break the zone via the Cloudflare API,
             then wait until the breakage is observable at the edge
2. ATTEMPT   hand over the ticket — a person, or an agent driving a browser
3. GRADE     read the live configuration and make real HTTP requests
4. RECORD    verdict and every check into D1
```

Step 3 knows nothing about step 2. It does not read a trace, a step count, or the agent's
own report, and it produces the same verdict whether the change came from a person
clicking in the dashboard, an agent, or a `curl` command. An agent claiming success on a
zone it never touched scores zero, which has been observed rather than assumed.

The ticket is fixed text, byte-identical for every attempt, and describes only the
symptom. Role framing — that you are on call, that a browser is open and signed in, that
writing a report is not the job — lives in the harness and is identical for every task and
every agent. Those are facts about the situation, not hints about the fix, so they cannot
advantage one attempt over another.

---

## The tasks

| # | Task | Tests whether the attempt can... |
| --- | --- | --- |
| 01 | **ssl-redirect-loop** `easy` | diagnose a redirect loop caused by Flexible SSL against an origin that forces HTTPS, and choose the mode that also satisfies a stated requirement to *verify* the origin certificate — not merely encrypt to it |
| 02 | **access-staging-lockdown** `hard` | put an identity challenge in front of one subdomain, scoped to a company email domain, using the identity provider already available on a Free plan — without putting a login in front of the public site |
| 03 | **waf-admin-lockdown** `medium` | compose a firewall rule covering an entire path prefix with a single-address exception, on a plan with no regex, without over-blocking the rest of the site |
| 04 | **dns-api-migration** `medium` | finish a botched cutover: a record pointing at a decommissioned host *and* left unproxied. Fixing only the address restores service while exposing the origin |
| 05 | **cache-stale-api** `medium` | find and undo a cache rule that overrides the origin's `no-store`. Deleting the rule and adding a bypass rule are both accepted — the origin already behaves correctly once nothing overrides it |
| 06 | **api-migration-incident** `hard` | hold four interacting requirements at once: DNS, verified origin TLS, cache, and a path lockdown — while the old deployment is still running and answering 200 |

Task 06 is the one worth reading the grader for. The decommissioned server is genuinely
still online, on a second address of the same box, serving an older release. It answers
200 perfectly happily. A grader checking status codes would pass a zone still pointed at
the wrong server; the check reads an origin marker instead.

Several plausible partial fixes look like success and are not, and each has a test:
repointing DNS while leaving the origin certificate unverified; turning off proxying to
make the service reachable, which the ticket forbids and which exposes the origin; a rule
broad enough to take the API down along with `/admin`; a rule with no exception, which
locks out the office too.

---

## Running it

Requires Node 20+, a Cloudflare zone you are willing to break, and an origin you control.
See [SETUP.md](./SETUP.md).

```bash
npm install
cp .env.example .env        # fill in — never committed

npm run cf-bench -- list
npm run cf-bench -- show   06-api-migration-incident   # the ticket, as an attempt sees it
npm run cf-bench -- seed   06-api-migration-incident   # break it, and confirm it is broken
npm run cf-bench -- grade  06-api-migration-incident   # check the live zone
npm run cf-bench -- verify 06-api-migration-incident   # full loop, end to end
```

`verify` is the integration test: seed → grade (expect fail) → apply a known-good fix →
grade (expect pass) → reset twice → confirm the broken state is live again. The
known-good fix exists only for this; grading never consults it, since a grader comparing
against one stored answer would be checking the method.

### Agent runs

```bash
npm run cf-bench -- agent-run 06-api-migration-incident \
  --agent browser-use --model openai/gpt-5.1 --max-steps 120
```

Resets the task, hands the ticket to a local agent driving a real Chrome window, then
grades the zone regardless of what the agent reports.

### Dashboard

```bash
npm run worker:dev    # :8788  — Worker + D1
npm run web:dev       # :5173  — dashboard
```

Each task shows a live `BROKEN` / `FIXED` badge read from the zone itself, and three
numbered actions: reset, open Cloudflare, grade. Nothing in the page explains itself; the
check list turns red and green as you work.

---

## Architecture

```
packages/cf/       typed Cloudflare REST client — zone settings, DNS, rulesets, Access
packages/coasty/   Coasty Computer Use API client + webhook verification
tasks/             task modules and the grader contract — no Node or Worker APIs,
                   so the same code runs in the CLI and inside the Worker
agents/            local browser-use runner (Python)
worker/            Hono on Workers + D1 run history
web/               React dashboard
origin/            nginx config for the origin — part of the benchmark's definition
scripts/           CLI
```

Tasks live in code, not in the database. A task *is* its seed/reset/grade triple; storing a
copy of its definition alongside the code that implements it would let the two drift.

Graders depend on a narrow structural interface rather than the client class, so each one
is unit tested against a hand-written fake of about thirty lines — which is what makes the
pass / fail / alternative-valid / plausible-but-wrong matrix cheap enough to write for
every task.

The HTTP probe follows redirects by hand. `fetch` collapses a loop into a generic error,
hiding the exact distinction a grader needs to report, which is why a failure reads
`301 http://… -> 301 https://…` rather than "request failed".

### Two agents, one grader

`browser-use` runs locally against a real Chrome profile. Coasty runs remotely and reports
back through a signed webhook. There is no adapter interface between them: they have
genuinely different shapes — one returns when its process exits, the other minutes later
over HTTP — and a single interface spanning both would have to model *maybe async, maybe a
webhook*. What they actually share is already shared and already agent-unaware: reset,
run record, grader, verdict.

The agent-agnostic property comes from the grader not knowing who made the change, not
from an abstraction layer.

---

## Security

Secrets live in `.dev.vars` and Wrangler secrets, never in the repo and never sent to the
frontend. The Cloudflare token is scoped to one zone plus the account-level Access
permission, which cannot be narrowed further — which is itself an argument for the
throwaway account this runs against.

`webhook_secret` is stored per run because Coasty returns it exactly once on creation, and
it is stripped explicitly on the way out rather than by relying on column ordering, so a
future column cannot leak by accident.

Agent runs provision real machines and bill real money, so the dispatch endpoint takes a
rate limit before dispatching, sets a machine TTL to bound the cost of a webhook that
never arrives, and terminates the machine before grading — grading takes tens of seconds
and the machine bills throughout.

The webhook receiver verifies the HMAC signature before trusting anything in the body,
including the run id it uses to look the secret up, and answers an unknown run id exactly
as it answers a bad signature, so it cannot be used to enumerate valid run ids.

---

## What is not finished

**Coasty runs have never been executed live.** The client is built against the documented
contract and verified end to end against the cookbook's offline mock server, including a
real dispatch, a signed webhook delivery, machine termination, and a grade. The webhook
verification is a WebCrypto port of their Node reference, tested against the HMAC vectors
published in their `API_NOTES.md` — both valid vectors and all four documented negative
cases. What has not happened is a run against `coasty.ai` itself, because API keys are
gated behind their paid plan. One divergence is already known: `POST /v1/tasks` is
documented but absent from the mock, which is why the client uses `/v1/machines` +
`/v1/runs`.

**browser-use is DOM-aware, not pixel-based.** It hands the model an indexed list of
interactive elements rather than only screenshots. That is more reliable on a dense SPA,
but it is a different category of agent from the screenshot-driven ones Coasty evaluates —
and the difference showed. Task 06's first failure was partly because *"the expression
textarea is not a separately indexable input element"*: the agent failed precisely where
the interface was not DOM-addressable. A pixel-based agent might not have that problem,
which is a concrete architectural difference the harness surfaced without being designed
to look for it.

**Six tasks is small**, and four of them exercise one dimension each. Task 06 suggests the
composite shape is where models actually separate.

**The grader runs from one vantage point.** It cannot make a request from the office
address, so the "this address is still allowed" half of the lockdown tasks is verified by
reading configuration rather than by connecting.

---

## Why it looks like this

Coasty evaluates computer-use agents on real software, resets environments to identical
snapshots, and grades the final outcome rather than the clicks taken. CF-Bench applies the
same three ideas to a domain where the outcome is machine-checkable.

That last part is the deliberate difference. Coarena uses human judges because its tasks
are open-ended — there is no function returning true or false, so a person has to say
which run was better. CF-Bench picks tasks where a function *can*: is the site returning
200, is the mode `strict`, does a stranger hit an identity challenge, did the response come
from the new server or the old one. No judge, no preference, no cost per verdict.

It is a narrower instrument, and free to run.
