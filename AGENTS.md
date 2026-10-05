# Bundled docs

Next.js, Turborepo and the AI SDK change faster than training data. Their installed packages ship version-matched docs; read the relevant page before using an API or changing configuration. Resolve a package from the workspace that depends on it (pnpm does not hoist): `node -p "require.resolve('next/package.json')"`.

- Next.js: `next/dist/docs/`
- Turborepo: `turbo/docs/README.md`, then the page it points to
- AI SDK: `ai/docs/` (see the `ai-sdk` skill, `.claude/skills/ai-sdk`). Models come only from `@repo/openai-subscription` (the owner's ChatGPT subscription): ignore the skill's AI Gateway and provider-package advice.

# Local database

Locally Postgres 17 runs in Docker (`compose.yaml`); production is Neon. `pnpm dev` runs `pnpm db:up` (start the container and wait until healthy), `pnpm db:migrate`, then `turbo run dev`, so it fails right away if Docker is not running. `pnpm db:down` stops the container and keeps the data volume.

`pnpm db:migrate` and drizzle-kit read the database URL from `apps/core/.env.local`; variables already set in the environment win over the file. Never point them at a production URL, never copy the production `SECRETS_ENCRYPTION_KEYS` into a local env file, and ask before `docker compose down -v` or `pnpm db:down -v` (they delete the local data). Schema and migration rules are in `docs/architecture/database.md`; read it before changing `packages/db`.

Claude Code is denied reading `.env` and `.env*.local` files (`.claude/settings.json`), and its sandbox enforces the same rule for shell commands. Commands that load `apps/core/.env.local` (`pnpm db:migrate`, `pnpm dev`, `pnpm build`) fail inside the sandbox and need it turned off, which takes the user's approval; when that is not given, ask the user to run them. Tests and type checks do not need the env file. `@repo/core` tests do need Docker: their Vitest global setup starts the `compose.yaml` container, recreates the `majordomo_test` database and migrates it, and the tests connect to `127.0.0.1:5432`. The sandbox blocks that connection, so they also need it turned off, with the user's approval.

# Errors

This codebase uses the errors-as-values convention (`@spotsccc/error-as-value`). Always read the `error-as-value` skill (`.claude/skills/error-as-value`) before editing TypeScript error handling.

Functions return `Error | T` and never throw expected failures. Throw only inside route handlers passed to `createHandler` (`if (result instanceof Error) throw result;`): it maps thrown `HandlerError`, `ValidationError` and `NotFoundError` to HTTP responses. `validateRequest` from `@repo/handler` runs inside those handlers and throws `BadRequestError` too. The other exceptions are third-party contracts that require throwing: AI SDK models, `fetch` wrappers, `refreshWithCredentialLease` callbacks and `db.transaction` callbacks.

`apps/core/src/lib/config.ts` also throws, on load: it parses the environment with zod and aborts the build or server start when a variable is missing or invalid (`src/instrumentation.ts` imports it at startup). Server code reads environment variables only through `config`, never `process.env` (variables set by the framework, such as `NEXT_RUNTIME`, are the exception), and does not check them again; a new variable goes into the config schema, `.env.example` and the `build` task's `passThroughEnv` in `turbo.json` (strict env mode hides undeclared variables from `next build`, which loads the config).

# Abstractions

Write the direct solution for the current requirement. Add an abstraction (a helper module, interface, generic, class, factory, wrapper, option, parameter or new package) only for one of these reasons:

- two or more real call sites or implementations exist today;
- a contract that a library or platform requires (an AI SDK provider, `createHandler`, `db.transaction`).

"It might be needed later" is not a reason, and neither is testability. Tests replace what they cannot control with Vitest: `vi.stubGlobal("fetch", ...)` for the network, `vi.useFakeTimers()` and `vi.setSystemTime()` for time, `vi.mock()` for modules. Do not add parameters or options such as `fetchFn` or `now` only so tests can inject them; existing ones are removed when that code is changed.

Do not add options, parameters or extension points that no caller passes, and do not write wrappers that only rename or forward a call. The doc comment of a new abstraction says which reason applies. When the reason disappears, inline the abstraction.

The repository is private and has no external consumers. When an API changes, update every call site: no deprecated aliases, re-exports of old paths or compatibility shims.

These rules win over examples in skills. Performance patterns such as `better-all`, cross-request caches and loop micro-optimizations apply only to a measured problem or a real hot path.

# Comments

Comments are documentation only: `/** */` TSDoc on declarations — the module header, functions, types, interface fields and constants. A doc comment states the contract (what it does, what it returns, which errors it returns as values, side effects) and the reasons behind non-obvious decisions. It does not repeat the name or the types.

Do not write `//` or `/* */` comments inside code, commented-out code or TODOs, even where nearby code has them. If a block needs explaining, put the explanation in the enclosing function's doc comment or extract the block into a named function with its own doc comment. Test files follow the same rule, and the test name describes the scenario.

Exceptions: tool directives with a reason (`// @ts-expect-error <reason>`, `// oxlint-disable-next-line <rule> -- <reason>`), generated files (`next-env.d.ts`, drizzle-kit migrations) and third-party files copied into `.claude/skills`.

Existing inline comments are migrated gradually: do not rewrite untouched files, but when you change a function, move its inline comments into its doc comment.

# TypeScript

No `any`. Data from outside the process (requests, environment, stored JSON, third-party responses) is parsed with zod at the boundary. Use `as` and non-null `!` only where a check right before them proves the type and TypeScript cannot narrow it; otherwise fix the types.

# Tests

Read the `minimal-mock-testing` skill (`.claude/skills/minimal-mock-testing`) before writing tests or a test harness. Mock only what tests cannot control, using Vitest as described in Abstractions.

# Dependencies

Ask before adding a dependency. First check whether Node.js, the platform or an existing dependency already covers the need.

# Before finishing

Run `pnpm format`, then `pnpm check-types`, `pnpm lint` and `pnpm test`, and report the result. `check-types` and `test` accept a package filter (`pnpm test --filter=@repo/db`); `lint` (oxlint) and `format` (oxfmt) always cover the whole repository and take about a second. Do not call a change done while one of them fails.
