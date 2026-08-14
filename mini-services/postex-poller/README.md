# PostEx Status Poller — Standalone Worker Service

## Status: SCAFFOLD ONLY (not functional yet)

This directory is **groundwork** for a future extraction of the PostEx status
poller from the main app's `instrumentation.ts` into an independent, singly-run
service. It is NOT wired into any docker-compose file and does NOT run any code.

## Why this exists

When FlowOps eventually runs multiple app replicas (horizontal scaling), the
in-process poller in `instrumentation.ts` would run on EVERY replica, causing:

- Duplicate PostEx API calls (wasting API quota)
- Duplicate dispatch/RTO triggers (double inventory deductions, double audit logs)
- Race conditions on order status updates

The solution is to run the poller as a **single dedicated worker** — this
mini-service — decoupled from the web app replicas.

## What this service WILL do (future, not implemented in Phase 3)

1. Import `pollPostExOrderStatuses()` from the main app's actions (or a shared
   library extracted from it)
2. Run it on a `setInterval` (every 30 minutes, matching the current schedule)
3. Connect to the same Supabase PostgreSQL database as the main app
4. Be deployed as a separate Docker container with `restart: unless-stopped`
5. The main app replicas set `ENABLE_IN_PROCESS_POLLER=false` so they don't
   also poll

## What is explicitly OUT OF SCOPE for Phase 3

- Actually moving `pollPostExOrderStatuses()` out of `instrumentation.ts`
- Wiring this service into `docker-compose.yml` or `docker-compose.prod.yml`
- Implementing the actual polling logic in `index.ts`
- Deciding cron scheduling vs. setInterval vs. external scheduler
- Webhook vs. polling precedence (PostEx webhooks may eventually replace
  polling entirely — that's a separate discussion)

These are all **SEPARATE, FUTURE tasks** requiring their own discussion.

## Current state

- `package.json` — minimal Bun project definition
- `Dockerfile` — placeholder (not functional)
- `index.ts` — does not exist yet (will be created when the extraction happens)

## How to enable the toggle (Phase 3 deliverable)

In the main app's environment (`.env.docker` or compose env):

```bash
# Keep the poller in-process (current behavior, single instance):
ENABLE_IN_PROCESS_POLLER=true

# Disable the in-process poller (for multi-replica or when using this worker):
ENABLE_IN_PROCESS_POLLER=false
```

When `ENABLE_IN_PROCESS_POLLER=false`, the main app logs:
```
[instrumentation] PostEx poller DISABLED (ENABLE_IN_PROCESS_POLLER=false)
```

And the poller does NOT start. The standalone worker (once implemented) would
be the sole poller.
