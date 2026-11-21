---
name: shipping-amplifier
description: >-
  End-to-end Amplifier delivery: implement, test locally, Bugbot, open PR, best-model
  review, fix findings, watch CI, merge, deploy/verify prod, close the ticket. Use when
  shipping, merging, deploying, closing issues, or when the user wants changes taken to
  production without babysitting routine PRs.
---

# Shipping Amplifier

Default path: **change → local verify → Bugbot → PR → best-model review → fix → CI green → merge → prod verify → close ticket**.

The user only reviews **controversial** or **cost-affecting** PRs (see `.cursor/rules/amplifier-delivery.mdc`). Everything else: ship without waiting.

## Checklist

```
Ship progress:
- [ ] 1. Scope + branch from issue
- [ ] 2. Implement (smallest change)
- [ ] 3. Local verify
- [ ] 4. Commit + push
- [ ] 5. Bugbot (fix real findings)
- [ ] 6. Open PR (`Fixes #N`)
- [ ] 7. Best-model PR review (fix or dismiss)
- [ ] 8. Human gate? controversial/cost → stop and ask
- [ ] 9. CI green (or local gate if no CI yet)
- [ ] 10. Merge
- [ ] 11. Prod deploy + smoke
- [ ] 12. Close/confirm ticket
```

## 1. Scope + branch

1. Confirm work belongs in **amplifier**, not `ample-music`.
2. Use / create a GitHub issue: `gh issue list --repo icy-house/amplifier --state open`
3. Branch from latest `main`: `issue-N-short-slug` or `fix/N-short-slug`.
4. Re-read product + security rules before auth/token work.

## 2. Implement

Follow `developing-amplifier`. Smallest change that closes the issue. No secrets in git or docs.

## 3. Local verify

Always:

```bash
npm run build
```

When tests exist: `npm test`. For auth changes, mentally walk: car QR → phone MusicKit → car poll with secret → single-use tokens.

Do not open a PR that fails local build/tests.

## 4. Commit + push

Commits are **expected** on this path (no extra “should I commit?”). Follow repo commit style; never `--no-verify` / force-push to `main`.

```bash
git push -u origin HEAD
```

## 5. Bugbot

Read and follow `~/.cursor/skills-cursor/review-bugbot/SKILL.md`.

- Launch Bugbot on **branch changes** before or immediately after opening the PR.
- **Fix** real findings; push again.
- **Do not** stop after reporting findings — this ship path includes remediation.
- Re-run Bugbot only if the diff grew substantially.

For auth/security-sensitive diffs, also run `/review-security` and remediate the same way.

## 6. Open PR

```bash
gh pr create --title "…" --body "$(cat <<'EOF'
## Summary
- …

## Test plan
- [ ] `npm run build`
- [ ] …

Fixes #N
EOF
)"
```

- Link the issue with `Fixes #N` (or `Closes #N`).
- One PR per issue unless the user asked to split.
- Point at `main`.

## 7. Best-model PR review

After the PR exists (and Bugbot findings are addressed), launch a **Task** `generalPurpose` subagent with the strongest available review model:

- Prefer `claude-opus-5-5-medium`; if unavailable, `claude-fable-5-2-high`.

Prompt it to review the PR diff for correctness, security regressions, and Amplifier threat-model violations. Require a severity-sorted table: Severity | Location | Finding.

Then:

- Fix must-fix / high findings; push.
- Dismiss invalid findings with a short PR comment.
- Ask the user only when a finding is ambiguous **and** touches auth, billing/cost, or data.

## 8. Human gate

Before merge, classify the PR:

| Stop and ask user | Ship without asking |
| --- | --- |
| Auth/session/token protocol or threat-model change | Docs, comments, README clarity |
| Firestore rules / CORS / CSP widening | Tests, typefixes, refactors with no behavior change |
| Public API break for the car client | Bugfixes that preserve protocol |
| Cost: minInstances, memory, schedules, new GCP products, paid APIs, org/billing moves | Security hardenings that only tighten controls |

If stopping: paste PR URL + why (controversial / cost) and wait. Do not merge.

## 9. CI

- If `.github/workflows` CI exists: `gh pr checks --watch` (or Autopilot / subscriptions). Fix failures in-scope; do not weaken CI to go green.
- If CI does **not** exist yet (see issue #9): local `npm run build` (+ tests) is the merge gate; note that in the PR.

Use `ci-investigator` for opaque check failures.

## 10. Merge

Only when: human gate passed (or N/A), required checks green (or no CI), Bugbot + best-model findings addressed.

```bash
gh pr merge --squash --delete-branch
```

Prefer squash. Do not `--admin` bypass unless the user explicitly asks.

## 11. Prod deploy + smoke

Production Firebase project: **`amplemusic-prod`** (see `.firebaserc`).

1. If a deploy workflow runs on `main`, watch it to success.
2. Otherwise, after merge:

```bash
git checkout main && git pull
npm run build
firebase deploy --only functions,hosting --project amplemusic-prod
```

(`npm run deploy` is functions-only; include hosting when `public/` or hosting config changed.)

Smoke:

- Auth page loads: `https://ample.icy.house/auth.html`
- `firebase functions:log --project amplemusic-prod` — no new error burst from the deploy
- For auth changes: confirm no unauthenticated token download path landed

Report deploy success/failure to the user in one short update.

## 12. Close ticket

1. Confirm `Fixes #N` closed the issue (`gh issue view N`).
2. If still open: `gh issue close N --comment "Shipped in <PR URL>; deployed to amplemusic-prod."`
3. Do not mark done until prod smoke is OK (or user accepted deploy risk).

## Anti-patterns

- Opening a PR without local build
- Reporting Bugbot/review findings and stopping on a ship request
- Merging controversial/cost PRs without explicit user OK
- Deploying with secrets in the diff or docs
- Leaving the issue open after a successful prod ship
- Force-pushing `main` or skipping hooks
