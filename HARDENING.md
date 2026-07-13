# Hardening / Cleanup Checklist

Working doc for the ChatGPT code-review hardening pass (started 2026-07-13). Every finding below
was independently re-verified against the actual code (file:line confirmed, no hallucinated
specifics) before being turned into a task.

Work top to bottom within a phase; phases are ordered by dependency (see "Notes / decisions log"
for why). Items within the same phase are independent and can be done in any order. Check items
off in the same commit that implements them, with a date.

**This file is gitignored on purpose** until Phase 3 is fully checked off — it currently
documents an unpatched Plex-token-exfiltration path and an unauthenticated arbitrary-path MPC-HC
launch endpoint, and committing that publicly before they're fixed isn't worth the zero benefit.
Once Phase 3 is done, un-gitignore and commit it.

## Phase 0 — Quick wins (do anytime, good session warm-ups)

- [x] Fix stale package.json description ("resolves Jellyfin items" → Plex) — (done 2026-07-13)
      `addon/app/package.json:5`
- [x] Dockerfile: copy `package-lock.json` too, use `npm ci --omit=dev` instead of *(done 2026-07-13)*
      `npm install --omit=dev` — `addon/Dockerfile:5-6`
- [x] `AppConfig.Load()`: log + surface corrupt config.json instead of silently resetting to *(done 2026-07-13)*
      defaults via a bare `catch` — `player-agent-app/AppConfig.cs:20-28`
- [x] Add `LICENSE` (MIT) at repo root — (done 2026-07-13)

## Phase 1 — Root-cause functional fix (unblocks real testing of Phase 2 later)

- [x] `playback-monitor.js` reads `process.env.PLAYER_AGENT_URL` directly at module load instead *(done 2026-07-13)*
      of going through the settings store like `play.js` does — under the documented
      Settings-page setup flow this is `undefined`, so progress-reporting/watched-marking/
      auto-advance silently fail on every poll. This is *why* that feature has sat "unverified,"
      not because it's untested — it's broken.
      `addon/app/src/playback-monitor.js:16` vs `addon/app/src/play.js:13-15`
  > **Approach:** extract `play.js`'s `getPlayerAgentUrl()` into a shared module with no
  > dependents (e.g. `addon/app/src/agent-config.js`) that both `play.js` and
  > `playback-monitor.js` import, called fresh on every poll (not cached). Keep it in its own
  > file rather than requiring `play.js` directly — `play.js` already lazy-requires
  > `playback-monitor.js` to dodge a circular import.

## Phase 3a — player-agent shared-secret auth (addon → player-agent)

- [x] Add bearer-token auth between the addon and player-agent-app. Currently `PlayServer.cs`'s *(done 2026-07-13)*
      `/play` binds `0.0.0.0`, has zero auth, and passes the received path straight into
      `ProcessStartInfo.ArgumentList` — pointing it at an attacker UNC root
      (`\\attacker-ip\share\x`) makes Windows attempt an SMB handshake against that host, a real
      NTLM-hash-capture vector, not just a nuisance.
      `player-agent-app/PlayServer.cs:23,28-62`, `player-agent-app/MpcLauncher.cs:31-37`
  > **Approach:** addon generates a random secret (`crypto.randomBytes(24).toString('hex')`),
  > stored as a new `playerAgentSecret` field in `settings-store.js`, with a "regenerate" action
  > on the Settings page. Same value pasted into a new `SharedSecret` field in player-agent-app's
  > `AppConfig`/`SettingsForm.cs`. Addon sends `Authorization: Bearer <secret>` on every request
  > to player-agent (`play.js`'s fetch, and the new `getPlayerStatus()` fetch in
  > `playback-monitor.js`). `PlayServer.cs` validates via
  > `CryptographicOperations.FixedTimeEquals` (constant-time), returns 401 on mismatch/missing.
  > Leave `/health` open (no side effects). **Fail-closed once a secret exists; while
  > `SharedSecret` is empty (fresh install), allow unauthenticated** — matches today's
  > "nothing works until configured" bootstrap, no regression during first-time setup.
  >
  > Why a shared secret over IP-allowlisting or mTLS: IP-allowlisting is weak on a typical DHCP
  > home LAN (phone/kiosk IPs roam) and doesn't stop a same-segment attacker; mTLS needs
  > cert-generation/rotation infrastructure disproportionate for a personal LAN tool.

## Phase 3b — player-agent path allowlist + pathmap boundary fix (same bug class)

- [x] Restrict the received `filePath` to configured UNC root(s) (new setting), reject *(done 2026-07-13)*
      URL-scheme prefixes and non-media extensions — `player-agent-app/MpcLauncher.cs:31-37`
- [x] Fix `toWindowsPath`'s plain `plexPath.startsWith(from)` — a mapping for `/media/movie` also *(done 2026-07-13)*
      incorrectly matches `/media/movies-other/...`. Require the next char after the matched
      prefix to be `/` or end-of-string — `addon/app/src/pathmap.js:12-19`

## Phase 3c — Admin-PIN gate on the addon's sensitive endpoints (fixes token exfiltration)

- [x] **This is the actual fix for the Plex-token exfiltration finding.** `POST /api/settings` *(done 2026-07-13)*
      currently accepts any `plexUrl` with only a `typeof === 'string'` check, and the next Plex
      fetch sends the real `X-Plex-Token` to whatever host is configured. Format validation alone
      can't stop this — a same-LAN attacker can still point it at their own local server.
      `addon/app/src/routes/settings.js:20-42`, `addon/app/src/plex.js:16-38`
  > **Approach:** keep all browsing/play/watched-toggle/scan endpoints open with no auth — that's
  > the explicit desired "walk up and browse" UX, don't break it. Gate only `POST /api/settings`
  > and everything in `routes/plex-auth.js` (`POST /pin`, `GET /pin/:id`, `POST /unlink`) behind
  > an admin PIN. Store a hash via `crypto.scryptSync` (built into Node, no new dependency) in
  > settings. Middleware in `server.js`:
  > ```js
  > function requireAdminPin(req, res, next) {
  >   const { adminPinHash } = readSettings();
  >   if (!adminPinHash) return next(); // not configured yet - bootstrap stays open
  >   const supplied = req.headers['x-admin-pin'];
  >   if (!supplied || !verifyPin(supplied, adminPinHash)) {
  >     return res.status(401).json({ error: 'Missing or incorrect admin PIN' });
  >   }
  >   next();
  > }
  > ```
  > Applied as `app.use('/api/settings', requireAdminPin, settingsRoutes)` and
  > `app.use('/api/plex-auth', requireAdminPin, plexAuthRoutes)`. First PIN-setting call needs no
  > PIN (none configured yet); every call after must present the correct one, including changing
  > the PIN itself. Frontend: Settings page JS caches the entered PIN in `localStorage` after
  > first success — same mental model as a garage keypad code, not a login screen.

## Phase 3d — Defense-in-depth URL scheme validation (quick, pairs with 3b/3c)

- [x] Reject `plexUrl`/`playerAgentUrl` values that aren't `http://`/`https://` — *(done 2026-07-13)*
      `addon/app/src/routes/settings.js:20-42`
- [x] Restrict the accepted Home Assistant URL to `Scheme == "http" || "https"` (currently *(done 2026-07-13)*
      accepts any absolute URI — `file://`, `ftp://`, custom schemes) —
      `player-agent-app/SettingsForm.cs:79`, `player-agent-app/MainForm.cs:75`

## Phase 2 — playback-monitor session state machine

(After 3a, so this is written once with auth already in place; testable now that Phase 1
actually delivers a working URL.)

- [x] Root cause of three separate findings: no single source of truth for "what session is *(done 2026-07-13)*
      currently active." Every `monitorPlayback()` call today creates an independent closure
      with its own `setInterval` (concurrent-monitor bug); the 90%-threshold branch conflates
      "mark watched" with "auto-advance and kill current playback" into one trigger (cuts off
      the last 10% of anything you're still actively watching).
      `addon/app/src/playback-monitor.js:35-86`, `addon/app/src/play.js:53`
  > **Approach:** module-level singleton session in `playback-monitor.js`:
  > ```js
  > let currentSession = null; // { id, item, interval, startedAt, markedWatched,
  >                             //   lastState, lastFraction, consecutiveFailures,
  >                             //   cancelled, polling }
  > function monitorPlayback(item) {
  >   if (currentSession) {
  >     clearInterval(currentSession.interval);
  >     currentSession.cancelled = true;
  >   }
  >   const session = { id: crypto.randomUUID(), item, startedAt: Date.now(),
  >                      markedWatched: false, lastState: null, lastFraction: 0,
  >                      consecutiveFailures: 0, cancelled: false, polling: false };
  >   currentSession = session;
  >   session.interval = setInterval(() => pollOnce(session), POLL_INTERVAL_MS);
  > }
  > ```
  > - New Play always supersedes/cancels the previous session — mirrors
  >   `MpcLauncher.PlayAsync` already force-killing any running MPC-HC before launching fresh.
  > - Guard re-entrancy with `session.polling`: skip a tick if the previous one is still
  >   awaiting `reportTimeline`/`markWatched`.
  > - Every `await` inside a tick re-checks `session.cancelled || session !== currentSession`
  >   immediately after resuming, not just once at the top.
  > - Two triggers, evaluated independently each tick:
  >   1. *Watched-mark*: `fraction >= WATCHED_THRESHOLD && !session.markedWatched` → mark
  >      watched, set the flag. Can fire while still `playing`.
  >   2. *Auto-advance*: fires only on a `lastState !== 'stopped' && state === 'stopped'`
  >      transition **and** `session.lastFraction >= AUTO_ADVANCE_THRESHOLD` (own named
  >      constant, independently tunable from `WATCHED_THRESHOLD` even if initially equal).
  >      `MpcStatus.cs`'s `state: 0` covers both "user closed" and "reached end of file" — the
  >      Web Interface can't distinguish them — so the fraction-near-end heuristic is the only
  >      available signal.
  > - Treat `/status` unreachable as session-ending only after `consecutiveFailures >= 3`, not
  >   a single flaky poll.
- [ ] Manually test end-to-end against real MPC-HC playback
- [x] Update README's "Playback monitoring" section with implemented behavior and explicit
      real-MPC verification status — (done 2026-07-13)

## Phase 4 — Remaining hardening/polish (independent ordering)

- [x] `settings-store.js` / `token-store.js` — non-atomic writes; switch to *(done 2026-07-13)*
      write-to-temp-then-`fs.renameSync`
- [x] `/image` route — stream the Plex image response instead of buffering the whole poster into *(done 2026-07-13)*
      memory — `addon/app/src/routes/api.js`
- [x] Cast thumbnails bypass the addon's own image proxy (unlike posters/backgrounds) — route *(done 2026-07-13)*
      them through it too, so they don't fail under Ingress/restricted network access
- [x] Move player-agent-app's `config.json` and log file from next to the exe to *(done 2026-07-13)*
      `%LocalAppData%\MediaLauncherPlayerAgent\` so it works from read-only install locations.
      One-time migration read of the old location if the new one is empty.
- [x] `StartWithWindows` defaults to `true` — change default to `false` so first run doesn't *(done 2026-07-13)*
      silently register autostart before the user has said yes to anything —
      `player-agent-app/AppConfig.cs:10`

## Phase 5 — Process/docs (last — only now is there finished logic/auth worth documenting)

- [x] `.github/workflows/` CI: `npm ci && npm test`/lint for `addon/app`, `dotnet build` for *(done 2026-07-13)*
      `player-agent-app`
- [x] Minimal test coverage for `pathmap.js`'s boundary-safe matching (Phase 3b) and the *(done 2026-07-13)*
      playback-monitor state machine (Phase 2), via Node's built-in `node:test` — no new
      dependency
- [x] `SECURITY.md` — LAN-only threat model, what the shared-secret/admin-PIN mechanisms do and *(done 2026-07-13)*
      don't protect against, how to report an issue
- [x] Troubleshooting doc + a simple architecture diagram — (done 2026-07-13)
      (addon ⇄ player-agent ⇄ MPC-HC ⇄ Plex) + `CHANGELOG.md` (backfill at least the breaking
      config-migration commit already in history)

## Notes / decisions log

- **2026-07-13** — Chose shared-secret PSK over mTLS/IP-allowlisting for addon↔player-agent auth:
  IP-allowlisting is weak on DHCP home LANs (roaming IPs) and doesn't stop a same-segment
  attacker; mTLS needs cert infra disproportionate to a personal LAN tool. PSK matches the
  pairing UX pattern of plenty of LAN IoT devices and needs no new dependency in either stack.
- **2026-07-13** — Chose admin-PIN gating over full login for the addon's own API: the explicit
  desired UX is "walk up and browse/play with zero login" (kiosk, phone). Only Settings-page and
  Plex-linking actions get gated; everything a household member touches during normal use stays
  open.
- **2026-07-13** — All 13 claims in the source ChatGPT review were independently re-verified
  against the real code (exact file:line matches) before being turned into tasks here — this
  isn't a review taken on faith.
