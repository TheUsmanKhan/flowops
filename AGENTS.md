# FlowOps ERP — AI Assistant Operating Rules & Repository Context

> **AUTOMATICALLY LOADED BY ANTIGRAVITY**  
> Read this before executing any command or making modifications in this repository.  
> Detailed guide: `PRODUCTION_DEPLOYMENT_GUIDE.md`

---

## 1. Database Architecture & Safety (MANDATORY)

- **DEV / Test Database**: 
  - Host: `aws-0-ap-south-1.pooler.supabase.com:5432` (Project ref: `gobwxqkzfulbwhzbbsdj`)
  - Stored in: Local `.env` file on this Mac.
  - Usage: ALL local development, testing, test users, test orders, and schema experimentation.
  - Rule: Local code runs ONLY against this DB.

- **PRODUCTION Database**:
  - Host: `aws-0-ap-south-1.pooler.supabase.com:5432` (Project ref: `phketufsvxqghkdgixli`)
  - Configured on: Hostinger environment variables (Domain: `https://op.muzammaldatabase.com`).
  - Usage: Live customer operations only.
  - 🚨 **CRITICAL RULE**: NEVER connect local test scripts or dummy data generators to the Production DB. NEVER put Production DB credentials into `.env` on this machine.

- **URL Password Encoding**:
  - Both database passwords contain `@`. When constructing or inspecting Postgres URLs, `@` MUST be URL-encoded as `%40` (`123%40...`), otherwise Prisma connection parsing fails.

---

## 2. Git & GitHub Operations

- **Remote**: `origin` -> `git@github.com:TheUsmanKhan/flowops.git` (Branch: `main`)
- **SSH Key**: The Mac has multiple keys. Always ensure Git uses Usman's key:
  `git config core.sshCommand "ssh -i ~/.ssh/id_ed25519_usman -o IdentitiesOnly=yes"`
- **Git Push Rules**:
  - Always verify that `.env` and `.pid` files are NOT staged (`.env` is in `.gitignore`).
  - Maintain both `bun.lock` and `package-lock.json` in sync for build compatibility.
  - When code is pushed to `main`, Hostinger automatically pulls/rebuilds for production.

---

## 3. Build & Hostinger Deployment Specifications

- **Platform**: Hostinger Web Apps / Cloud Server
- **Domain**: `https://op.muzammaldatabase.com`
- **Build Command**: `npm run build`
- **Output Directory**: `.next`
- **Node Version**: `22.x`
- **Dependencies Rule**: 
  - Do not put build-required packages (`tailwindcss`, `typescript`, `@types/*`) in `devDependencies`, because npm omits them when `NODE_ENV=production` is set during deployment. Keep them in `dependencies`.
  - Do not import `@next/bundle-analyzer` in `next.config.mjs`.

---

## 4. Standard Workflow for Any Request

1. **Implement on Local**: Make changes in `src/` or `prisma/`.
2. **Local Verification**: Test against the Dev Database using `bun run dev` or `npm run build` + `bun run start`.
3. **User Approval**: Confirm the changes with the user.
4. **Git Commit & Push**: Commit with meaningful messages and push to `origin main` using the configured SSH key.
