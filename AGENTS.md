<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Local database

Locally Postgres 17 runs in Docker (`compose.yaml`); production is Neon. `pnpm dev` runs `pnpm db:up` (start the container and wait until healthy), `pnpm db:migrate`, then `turbo run dev`, so it fails right away if Docker is not running. `pnpm db:down` stops the container and keeps the data volume.

`pnpm db:migrate` and drizzle-kit read the database URL from `apps/core/.env.local`; variables already set in the environment win over the file. Never point them at a production URL, never copy the production `SECRETS_ENCRYPTION_KEYS` into a local env file, and ask before `docker compose down -v` (it deletes the local data). Schema and migration rules are in `docs/architecture/database.md`; read it before changing `packages/db`.

# Errors

This codebase uses the errors-as-values convention (`@spotsccc/error-as-value`). Always read the error-as-value skill before editing TypeScript error handling.

Functions return `Error | T` and never throw expected failures. Throw only inside route handlers passed to `createHandler` (`if (result instanceof Error) throw result;`): it maps thrown `HandlerError`, `ValidationError` and `NotFoundError` to HTTP responses. The other exceptions are third-party contracts that require throwing: AI SDK models, `fetch` wrappers, `refreshWithCredentialLease` callbacks and `db.transaction` callbacks.
