# Project Rules (AGENTS.md)

> This file is read by `yes-my-pi` to understand project-specific constraints.
> Copy this template to your project root directory and modify as needed.
> Note: Rules defined here supplement the global `SYSTEM.md` rules.

## Project Overview

<!-- Provide basic project info to help the AI understand the context -->

- **Name**: <!-- e.g., my-awesome-app -->
- **Description**: <!-- 1-2 sentences on what this project does -->
- **Tech Stack**: <!-- e.g., Next.js 14, TailwindCSS, Prisma, PostgreSQL -->
- **Package Manager**: <!-- npm | yarn | pnpm | bun -->

### Commands

<!-- Specify exact commands to prevent the agent from guessing or using the wrong package manager -->

- **Install**: `<!-- e.g., pnpm install -->`
- **Build**: `<!-- e.g., pnpm build -->`
- **Test**: `<!-- e.g., pnpm test -->`
- **Lint**: `<!-- e.g., pnpm lint -->`
- **Format**: `<!-- e.g., pnpm format -->`

## Code Standards

<!-- Define project-specific style requirements. The agent will prioritize matching existing code, but these explicit rules help with edge cases. -->

- **Indentation**: <!-- e.g., 2 spaces -->
- **Quote Style**: <!-- e.g., Single quotes for JS/TS, Double quotes for JSX -->
- **Naming Conventions**: <!-- e.g., camelCase for variables/functions, PascalCase for components/types -->
- **File Organization**: <!-- e.g., One React component per file, co-locate styles as `*.module.css` -->
- **Import Order**: <!-- e.g., 1. External libs -> 2. Internal aliases (@/) -> 3. Relative paths -> 4. Styles -->

## Testing Requirements

<!-- Define testing rules to ensure regressions are caught -->

- **Framework**: <!-- e.g., Vitest, Jest, Playwright -->
- **Rule**: You MUST run the test command after modifying any business logic.
- **Rule**: New features MUST include corresponding tests.
- **Coverage Requirement**: <!-- e.g., Maintain > 80% coverage for new code -->
- **Test File Location**: <!-- e.g., Co-located as `*.test.ts` next to the source file -->

## Git Standards

<!-- Define commit and branch rules -->

- **Commit Format**: `type(scope): description` (Conventional Commits)
- **Allowed Types**: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`
- **Pre-commit Checks**: Lint and tests MUST pass before committing.
- **Branching**: <!-- e.g., feature/xxx, fix/xxx. Never commit directly to `main` -->

## Forbidden Actions

<!-- Define what the AI absolutely MUST NOT do in this project -->

- **DO NOT** modify lockfiles (e.g., `package-lock.json`, `pnpm-lock.yaml`) manually; use the package manager.
- **DO NOT** delete existing test files.
- **DO NOT** modify CI/CD configurations (e.g., `.github/workflows/`, `gitlab-ci.yml`) without explicit user confirmation.
- **DO NOT** introduce new third-party dependencies without asking for permission and explaining the use case.
- **DO NOT** <!-- Add other project-specific taboos, e.g., touch the generated `/dist` folder, modify database seeds -->

## Directory Structure

<!-- Provide a high-level map of key directories to help the AI navigate faster -->

```text
.
├── src/
│   ├── components/   # Reusable UI components
│   ├── pages/        # Route-level views
│   ├── services/     # API calls and external integrations
│   ├── utils/        # Helper functions and pure logic
│   └── types/        # Shared TypeScript types and interfaces
├── tests/            # E2E or integration tests
├── package.json
└── AGENTS.md
```
