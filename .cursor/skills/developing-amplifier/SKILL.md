---
name: developing-amplifier
description: Develop and change the Amplifier Firebase backend for AmpleMusic car QR login. Use when working in this repo, implementing GitHub issues, touching auth sessions, MusicKit tokens, Firebase Functions, auth.html, CI, or security hardening.
---

# Developing Amplifier

## Product (keep this framing)

Amplifier is the helper service for **AmpleMusic**, the Apple Music app in the car.

Logging into Apple Music on a car screen is awkward, so the car shows a QR code. You scan it on your phone, sign in there, and Amplifier passes the login back to the car so the car can play your music.

## Before coding

1. Confirm the change belongs in **amplifier** (backend), not `ample-music` (Android).
2. Check open issues: `gh issue list --repo icy-house/amplifier --state open`
3. Re-read `.cursor/rules/` (product, security, TypeScript) — do not reopen Firebase-vs-GCP/Rust.
4. For auth/token work, sketch the threat model: who holds `sessionId`, who holds poll secret, what tokens leave the server.

## Implementation order (default)

Prefer this sequence unless the user picks a ticket:

1. Remove leaked secrets from docs / rotate if needed
2. Session protocol hardening (poll auth, server IDs, single-use)
3. Complete MusicKit user-token flow + correct developer JWT
4. Secret Manager for `.p8` + supported Node / `firebase-functions`
5. Hosting/CORS/CSP/`auth.html` hardening + durable rate limits
6. Tests → CI/CD → dedicated vuln-scan workflow

## Working rules

- Stay on Firebase; smallest change that closes the issue.
- Update README only when behavior or setup truly changes; keep the plain-language purpose at the top.
- Never put passwords or `.p8` material in the repo.
- Add or extend tests with new auth behavior; variable under test named `fixture`; no underscores in test method names.
- Link PRs to issue numbers (`Fixes #N`).

## Verify

- `npm run build` (and `npm test` once tests exist)
- Mentally walk: car QR → phone sign-in + MusicKit → car poll with secret → tokens once
- Confirm no unauthenticated token download and no client Firestore access to sessions

## Related issues

Track work on https://github.com/icy-house/amplifier/issues — P0 security/functionality first.
