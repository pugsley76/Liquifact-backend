# Contributing to LiquiFact Backend

Thanks for contributing to the LiquiFact backend. This guide documents the workflow, branch naming, local checks, and CI expectations used by this repository and the GrantFox OSS campaign.

## Local Setup

Use Node.js 20 and npm 9 or newer.

```bash
npm install --no-package-lock
cp .env.example .env
```

For database-backed work, start the local services and run migrations:

```bash
docker-compose -f docker-compose.dev.yml up -d
npm run db:migrate
```

Run the API locally with:

```bash
npm run dev
```

## Branch Naming

Create focused branches from `main` using the campaign convention:

```text
<type>/<area>-<issue-number>-<short-slug>
```

Examples:

```text
docs/contributing-291-ci-expectations
fix/invoices-42-state-transition
feature/escrow-18-reconciliation
```

Keep each branch scoped to one issue or one cohesive change.

## Commit Style

Use clear, conventional-style commit messages when possible:

```text
docs: add backend contributing guide
fix: validate invoice state transitions
test: cover escrow reconciliation failure path
```

## Local Checks

Run the checks that apply to your change before opening a pull request:

```bash
npm run lint
npm test
npm run build
npm run typecheck
```

The current CI workflow installs dependencies with `npm install --no-package-lock`, runs lint on changed JavaScript files, runs the full lint job as allowed-to-fail, executes `npm test`, and checks `src/index.js` syntax with `node --check`.

For docs-only changes, verify the changed Markdown links and note that no runtime tests were needed. For code changes, include the commands and results in the pull request description.

## Testing Expectations

- Add or update tests for changed behavior under `tests/`.
- Prefer focused unit tests for service or middleware logic and integration tests for route behavior.
- Use existing helpers in `tests/helpers/` before creating new test setup.
- Keep tests deterministic; mock external network, Stellar, S3, Sentry, and database dependencies where existing patterns do so.
- If an issue asks for coverage, run `npm run test:coverage` and include the relevant result.

## Security and Data Handling

This backend handles invoice data, authentication, escrow state, and payment-adjacent workflows. Do not commit secrets, `.env` files, private keys, API keys, bearer tokens, or generated credentials. When changing auth, upload, webhook, or payment-related code, include a short security note in the PR covering the trust boundary and validation path.

## Pull Request Checklist

Before requesting review, confirm:

- The PR references the issue with `Closes #<issue-number>`.
- The diff is scoped to the requested behavior or documentation.
- Relevant tests were added or updated.
- `npm test` was run for code changes.
- `npm run lint`, `npm run build`, or `npm run typecheck` were run where relevant.
- Migration changes include rollback or operational notes.
- No secrets, generated build output, or unrelated formatting churn is included.

## Community and Campaign

LiquiFact backend tasks may be part of the GrantFox OSS / Official Campaign. Use the LiquiFact Discord linked in campaign issues for coordination, review questions, and reward follow-up after eligible merged work.