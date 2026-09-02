# ════════════════════════════════════════════════════════════════════
# FlowOps ERP — Production Dockerfile
# ════════════════════════════════════════════════════════════════════
# Multi-stage build: deps → builder → runner
#
# The production image contains ONLY the compiled standalone bundle
# (no source code, no devDependencies, no .next/cache). This keeps it
# small and secure.
#
# Bun version is pinned to 1.3.14 (exact tag, not :latest) for
# reproducibility.
# ════════════════════════════════════════════════════════════════════

# ─── Stage 1: base ───────────────────────────────────────────────────
FROM oven/bun:1.3.14 AS base
WORKDIR /app

# ─── Stage 2: deps ───────────────────────────────────────────────────
# Install ALL dependencies (including devDeps for prisma generate + build)
# Cached separately from source code changes — only re-runs when
# package.json or bun.lock changes.
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ─── Stage 3: builder ────────────────────────────────────────────────
# Copy deps + full source, generate Prisma Client, build the standalone
# Next.js bundle.
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma Client (required before build — the standalone bundle
# includes the generated client)
RUN bunx prisma generate

# Build Next.js (produces .next/standalone/ with the self-contained server)
# The build script also copies .next/static and public/ into standalone/
RUN bun run build

# ─── Stage 4: runner ─────────────────────────────────────────────────
# Final production image — only the standalone output, no source code.
FROM base AS runner

# Create a non-root user for security
RUN addgroup --system --gid 1001 flowops \
  && adduser --system --uid 1001 --ingroup flowops flowops

WORKDIR /app

# Copy the standalone server (self-contained: includes only the needed
# node_modules + server.js)
COPY --from=builder --chown=flowops:flowops /app/.next/standalone ./
COPY --from=builder --chown=flowops:flowops /app/.next/static ./.next/static
COPY --from=builder --chown=flowops:flowops /app/public ./public

# Copy Prisma schema (needed at runtime for db:push if run inside container)
COPY --from=builder --chown=flowops:flowops /app/prisma ./prisma

# Switch to non-root user
USER flowops

# Expose the app port
EXPOSE 3000

# Production environment
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Health check — hits /api/health every 30s, allows 10s for response,
# 5s startup grace, 3 retries before marking unhealthy
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Start the standalone server (matches the current production start command:
# `NODE_ENV=production bun .next/standalone/server.js`)
# The standalone server.js is at the root of the standalone output
CMD ["bun", "server.js"]
