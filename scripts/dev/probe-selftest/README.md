# probe-selftest - does the probe reach the right verdict?

`POST /capability/models/:id/probe` is the route that decides whether an
operator can trust a model they just configured. Its verdict is only meaningful
against a real upstream response, and the responses that matter most are the
awkward ones - a model that spends its whole output budget on a reasoning chain
and answers nothing.

Reproducing that against a live vendor costs money, needs a credential the
machine may not have, and is not reproducible: the model may simply answer next
time. So the awkward response is served locally.

```
scripts/dev/probe-selftest/run.sh sha-3b5e99d     # a CI-built image
scripts/dev/probe-selftest/run.sh local           # whatever you built
KEEP=1 scripts/dev/probe-selftest/run.sh sha-...  # leave the stack up on :3102
```

Exit code is 0 when every assertion holds and 1 when any fails, so this is
usable as a gate and not only by eye.

## What it stands up

An **isolated** val stack - its own compose project, network, database, data
dir and port (3102). It does not touch the dev stack on 3100, and it deletes
`./data/val` on the way out.

Three extra containers, none of them publishing a port:

| | why |
|---|---|
| `stub` | a DeepSeek-V4-shaped thinking model (`stub-upstream.mjs`) |
| `dev-issuer` | the operator plane is guarded; without a mintable token the probe route cannot be reached at all |
| `db` | the real DDL, applied in db-init order, including `incr/` |

## What it asserts

| fixture | expectation |
|---|---|
| `stub-thinking` | both legs FAIL - and the chat leg must NAME the reasoning chain rather than say `empty model response` |
| `stub-thinking-capped` | the probe sends 512, not its 2048 default: exceeding a model's declared ceiling is a 400, i.e. a fake onboarding failure on a model that works |
| `stub-no-thinking` | both legs PASS, and `thinking` is observed ON THE WIRE |

The last one is the assertion that catches a whole class of regression. It reads
the stub's record of what Atlas actually **sent**, so "the switch is configured"
and "the switch was transmitted" cannot be confused - which is exactly how a
registry key becomes something nothing reads.

The streaming assertion is the one with history. It used to pass on a model that
delivered nothing: HTTP 200, usage complete, not one token of content, because
the check only asserted that no exception was thrown. A self-check that can
return a false pass is worse than none, because it is trusted.

## Is it actually a detector?

Yes, and that was verified rather than assumed. Run against `sha-d123344` - the
last image built before the probe fix - **9 of 12 assertions fail** and the
script exits 1. Against `sha-3b5e99d` all 12 pass and it exits 0.

If you change the probe and this still passes, check that it is detecting
anything at all before believing it.

## The numbers are real

`prompt_tokens: 84` / `completion_tokens: 16` / `total_tokens: 100` and the
cache and reasoning splits in `stub-upstream.mjs` are what `api.deepseek.com`
actually returned for `{"messages":[{"role":"user","content":"ping"}],
"max_tokens":16}` on 2026-08-24. That 100 is also the number in the original bug
report, where it looked like proof the model had answered.

## What it does NOT prove

That any particular vendor behaves this way. The stub is a model of DeepSeek's
documented and observed behaviour, not the vendor itself. A field DeepSeek
renames tomorrow will not show up here - that needs a real call with a real
credential.
