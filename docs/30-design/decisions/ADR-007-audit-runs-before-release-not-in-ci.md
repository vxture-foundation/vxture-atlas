# ADR-007: The audit runs before a release, not in CI

- Status: Accepted
- Date: 2026-08-26
- Deciders: owner

## Context

`scripts/audit/` re-plants a known defect in front of every CI guardrail and
every pinned service invariant and requires each one to go red. It exists
because a check that has never been seen red does not exist yet: "clean" and
"not running" print the same line. Its first run found `check-workflows`
claiming to keep each workflow's triggers while only checking that some trigger
was present.

CLAUDE.md step 3 already requires `pnpm audit:run` before pushing, and step 6
routes every deploy - dev included - through step 3. The open question was
whether to also make it a CI job, on the argument that a rule enforced only on
a developer's machine is itself a claim nothing binds, which is this repo's
most-repeated defect shape.

### What it would cost, measured

`organizations/vxture-foundation/settings/billing/usage`, read 2026-08-26:

```
product: actions | sku: Actions Linux | quantity: 996.0 Minutes
grossAmount $5.976 | discountAmount $5.976 | netAmount $0.00
```

996 minutes on this repo between 2026-08-01 and 08-25, entirely absorbed by the
free allowance (2,000 minutes/month for private repositories on a Free
organization), so nothing has been paid. At roughly 40 minutes a day the month
lands near 1,230 minutes - about 62% of the allowance.

The shape of the bill matters more than the total. **Actions bills per job,
rounded up to the whole minute.** One `ci.yml` run takes 105 seconds of wall
clock and is billed 5-7 minutes, because it has five jobs. Job count drives
cost, not duration.

Run volume over the preceding 30 days: ci 62, secret-scan 89, sonar 62, build
21, direct-push-audit 23, release 10, deploy 13.

The audit takes about 36 seconds locally; on a 2-vCPU standard Linux runner,
estimate 70-110 seconds. Against that:

| Option | Estimated monthly cost | Share of allowance |
|--------|------------------------|--------------------|
| A new job on every PR | 125-190 min | 6-10% |
| A step inside an existing job | 62-124 min | 3-6% |
| Release path only | 20-30 min | ~1.5% |
| Self-hosted runner on worker-02 | 0 | 0 |
| Make the repository public | 0 | 0 |

### Two things CI would have needed first

- `platform-claims` reads `environments/production` protection rules. The
  default `GITHUB_TOKEN` has no admin read, so those probes would answer
  `unknown` - which this audit reports as `unreadable`, never as a pass.
  Running it in CI means adding a PAT as an org secret. The dimension that
  exists because a claim about the platform was wrong is the one hardest to
  move into CI.
- `guardrail-mutation` uses `git worktree`, and `actions/checkout` defaults to a
  shallow clone. It would probably work, and by this audit's own first rule,
  "probably" is not evidence - it would have to be seen working.

## Decision

**The audit is not wired into CI.** It stays where CLAUDE.md already puts it: a
required step before pushing, and - through step 6 - before deploying to any
environment.

Not adding it is a decision, not an omission. Anyone reading `ci.yml` and
finding no audit job should read this file rather than filing the gap again.

## Consequences

- Roughly 80-150 minutes a month are not spent, on an allowance that is already
  about 62% consumed. The five required contexts stay a set of five, which
  CLAUDE.md treats as a contract.
- **Nothing enforces it.** That is the real cost and it is stated plainly rather
  than argued away: the audit is now in the same category as every other rule in
  this repo's discipline-substitute section - held by people, not by tooling,
  because branch protection is unavailable on this plan anyway. The compensating
  fact is placement: it sits on the release path, where skipping it has a cost,
  not on a checklist nobody opens.
- The `unreadable` severity keeps its meaning. In CI, `platform-claims` would
  have produced `unreadable` findings on every run from a missing token, and a
  severity that fires constantly stops being read.

## What would reopen this

- The repository becoming public. Standard-runner minutes become free, and the
  same change lifts the branch-protection block (the 403 reads "Upgrade to
  GitHub Pro or make this repository public"), so required checks would become
  enforceable at the same moment the audit became free to run.
- A self-hosted runner on worker-02, which consumes no included minutes.
- Evidence that the step is being skipped before releases. The decision rests on
  it actually being run; if it is not, the cheap option stopped being the
  correct one.
