# rebuild - Branch-protection ruleset

`main-ruleset.json` is the authoritative branch-protection ruleset (governance
standard section 1 pins this exact path as a naming exemption from the
directory-numbering rule). Apply it via `gh api repos/vxture/vxture-atlas/rulesets`
- legacy `branches/*/protection` returns 404.

Apply LAST, not first: `git init` -> `main` -> first push -> one CI run
(produces the five required check contexts) -> then apply this ruleset.
