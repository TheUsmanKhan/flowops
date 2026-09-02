# ════════════════════════════════════════════════════════════════════
# FlowOps PostEx Poller — Placeholder Dockerfile
# ════════════════════════════════════════════════════════════════════
#
# ⚠️  THIS IS A PLACEHOLDER — NOT FUNCTIONAL YET.
#
# This Dockerfile is scaffolded as groundwork for a future extraction of
# the PostEx status poller into a standalone worker service. It is NOT
# wired into any docker-compose file and will NOT build successfully
# because index.ts does not exist yet.
#
# When the extraction is performed (a separate, future task), this
# Dockerfile will:
#   1. Install dependencies (Prisma Client + the shared polling logic)
#   2. Copy the worker entry point (index.ts)
#   3. Run `bun index.ts` as the CMD
#   4. Connect to the same Supabase PostgreSQL as the main app
#
# The main app replicas would set ENABLE_IN_PROCESS_POLLER=false so only
# this worker runs the poller.
#
# See README.md in this directory for the full plan + out-of-scope notes.
# ════════════════════════════════════════════════════════════════════

FROM oven/bun:1.3.14
WORKDIR /app

# Placeholder — index.ts does not exist yet.
# When implemented, this will copy package.json, install deps,
# copy the worker code, and run it.
#
# COPY package.json ./
# RUN bun install --frozen-lockfile
# COPY . .
# RUN bunx prisma generate
# CMD ["bun", "index.ts"]

CMD ["echo", "PostEx poller worker — not implemented yet. See README.md."]
