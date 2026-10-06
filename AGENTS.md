# Bundled docs

Next.js, Turborepo and the AI SDK change faster than training data. Their installed packages ship version-matched docs; read the relevant page before using an API or changing configuration. Resolve a package from the workspace that depends on it (pnpm does not hoist): `node -p "require.resolve('next/package.json')"`.

- Next.js: `next/dist/docs/`
- Turborepo: `turbo/docs/README.md`, then the page it points to
- AI SDK: `ai/docs/` (see the `ai-sdk` skill, `.claude/skills/ai-sdk`). Models come only from `@repo/openai-subscription` (the owner's ChatGPT subscription): ignore the skill's AI Gateway and provider-package advice.

# Local database

Locally Postgres 17 runs in Docker (`compose.yaml`); production is Neon. `pnpm dev` runs `pnpm db:up` (start the container and wait until healthy), `pnpm db:migrate`, then `turbo run dev`, so it fails right away if Docker is not running. `pnpm db:down` stops the container and keeps the data volume.

`pnpm db:migrate` and drizzle-kit read the database URL from `apps/core/.env.local`; variables already set in the environment win over the file. Never point them at a production URL, never copy the production `SECRETS_ENCRYPTION_KEYS` into a local env file, and ask before `docker compose down -v` or `pnpm db:down -v` (they delete the local data). Schema and migration rules are in `docs/architecture/database.md`; read it before changing `packages/db`.

Claude Code is denied reading `.env` and `.env*.local` files (`.claude/settings.json`), and its sandbox enforces the same rule for shell commands. Commands that load `apps/core/.env.local` (`pnpm db:migrate`, `pnpm dev`, `pnpm build`) fail inside the sandbox and need it turned off, which takes the user's approval; when that is not given, ask the user to run them. Tests and type checks do not need the env file. `@repo/core` tests do need Docker: the Vitest global setup (`apps/core/vitest.global-setup.ts`) and the Playwright one (`apps/core/e2e/global-setup.ts`) start the `compose.yaml` container, recreate the `majordomo_test` or `majordomo_e2e` database and migrate it, and the tests connect to `127.0.0.1:5432`. Component and e2e tests also start Chromium and listen on local ports. The sandbox blocks all of this, so these tests need it turned off too, with the user's approval.

# Errors

This codebase uses the errors-as-values convention (`@spotsccc/error-as-value`). Always read the `error-as-value` skill (`.claude/skills/error-as-value`) before editing TypeScript error handling.

Functions return `Error | T` and never throw expected failures. Throw only inside route handlers passed to `createHandler` (`if (result instanceof Error) throw result;`): it maps thrown `HandlerError`, `ValidationError` and `NotFoundError` to HTTP responses. `validateRequest` from `@repo/handler` runs inside those handlers and throws `BadRequestError` too. The other exceptions are third-party contracts that require throwing: AI SDK models, `fetch` wrappers, `refreshWithCredentialLease` callbacks and `db.transaction` callbacks.

`apps/core/src/lib/config.ts` also throws, on load: it parses the environment with zod and aborts the build or server start when a variable is missing or invalid (`src/instrumentation.ts` imports it at startup). Server code reads environment variables only through `config`, never `process.env` (variables set by the framework, such as `NEXT_RUNTIME`, and e2e tooling in `apps/core/e2e`, which is never bundled, are the exceptions), and does not check them again; a new variable goes into the config schema, `.env.example` and the `build` task's `passThroughEnv` in `turbo.json` (strict env mode hides undeclared variables from `next build`, which loads the config), and gets an e2e value in `E2E_ENV` of `apps/core/e2e/env.ts`, even when optional (an empty string will do): otherwise `next build` and `next start` of the e2e server fill it from `.env.local`. A required variable also goes into the `env` of the `node` project in `apps/core/vitest.config.ts`.

# Abstractions

Write the direct solution for the current requirement. Add an abstraction (a helper module, interface, generic, class, factory, wrapper, option, parameter or new package) only for one of these reasons:

- two or more real call sites or implementations exist today;
- a contract that a library or platform requires (an AI SDK provider, `createHandler`, `db.transaction`).

"It might be needed later" is not a reason, and neither is testability. Tests replace only what they cannot control, with Vitest: `vi.stubGlobal("fetch", ...)` for the network, `vi.useFakeTimers()` and `vi.setSystemTime()` for time, and `vi.mock()` only for a third-party module that reaches an uncontrollable system and cannot be stubbed lower. Project modules and controllable libraries are never mocked (see Tests). Do not add parameters or options such as `fetchFn` or `now` only so tests can inject them; existing ones are removed when that code is changed.

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

Read the `minimal-mock-testing` skill (`.claude/skills/minimal-mock-testing`) before writing tests or a test harness. Where it differs from this section (it lets unit tests use simple fakes and names the kinds differently), this section wins.

A test sits in the same directory as the code it tests and its name says its kind: `<tested-file>.<kind>.test.ts`, where `<tested-file>` is the tested file's name without the extension (`client-errors.ts` → `client-errors.unit.test.ts`, `route.ts` → `route.api.test.ts`). Component tests end in `.tsx`. E2e tests are the exception: they live in `apps/core/e2e/`. Code shared by tests (helpers, fakes, test database setup) is named `<topic>.test-utils.ts` and sits next to the code it wraps or in the closest directory common to its users (`apps/core/src/lib/chatgpt.test-utils.ts`, `apps/core/test-database.test-utils.ts`); application code never imports it, and package builds leave it out together with the tests (`packages/openai-subscription/tsconfig.build.json`). In `apps/core`, Vitest refuses to start when a test file in `src/` or `e2e/` is named otherwise (`vitest.config.ts`); the packages have no such check.

The kind follows from what the code is, not from what is convenient to mock:

- **unit** (`*.unit.test.ts`): pure functions without dependencies, meaning no database, network, filesystem, environment or config, clock or module state. Nothing is mocked: input in, output checked. A function with dependencies does not get a unit test with fake dependencies; it gets a module test.
- **module** (`*.module.test.ts`): a module together with its dependencies. Everything controllable is real: Postgres (the Docker database in `apps/core`; PGlite with the real migrations in `packages/db`), the filesystem in a temporary directory, config from the test environment, other project modules and libraries. Only what tests cannot control is replaced, as described in Abstractions: external services, including their failures (a 5xx, a timeout, a malformed response, `invalid_grant`) through the same stub, and time. A controllable dependency is never faked to make it fail; trigger the failure for real (a constraint violation, an unwritable temporary directory).
- **api** (`route.api.test.ts` next to `src/app/api/**/route.ts`): the contract of a route handler. The test calls the exported handler with a `Request` and checks status codes, response shapes and headers, and the error codes the client parses: 401 without credentials (checked before the body), 400 for malformed input, the format of a successful response. Dependencies are real, as in module tests. It does not check that the logic is right; the module tests of the modules the route calls do that.
- **component** (`*.component.test.tsx`, `apps/core`): React components in headless Chromium (Vitest browser mode with Playwright), without the Next.js server and the database. They check behavior and appearance. Render with `vitest-browser-react`, act through locators, replace the network with `vi.stubGlobal("fetch", ...)`, and build streamed responses with the AI SDK (`createUIMessageStreamResponse`) rather than hand-written SSE. Appearance is checked with `toMatchScreenshot` against references committed in `__screenshots__/` next to the test, one per browser and OS. A missing reference is created by a run that fails: look at the image, then run again. After an intended UI change, update the references with `pnpm --filter @repo/core exec vitest run --project component -u` and look at the new images. `getByText("…")` matches an element's whole text; use a RegExp for a part of it.
- **e2e** (`apps/core/e2e/<scenario>.e2e.test.ts`): user scenarios in Playwright, on one page or across several. They run against the production build (`next build`, then `next start` on port 3100) and the `majordomo_e2e` database, which is recreated and migrated before the run (`e2e/global-setup.ts`). Tests seed the database and check what was saved through app modules (`@/lib/chatgpt.test-utils`, `@/lib/db`, `@/lib/openai`); `playwright.config.ts` gives the test processes the server's environment (`e2e/env.ts`). OpenAI is the only fake. `e2e/fake-openai.ts`, loaded into `next start` with `NODE_OPTIONS=--import`, sends the server's requests for chatgpt.com and auth.openai.com to the fake in the Playwright worker and refuses every other external request. A test answers them with `openai.on("METHOD https://host/path", handler)` from `e2e/fixtures.ts`, and a request without a handler fails the test. Tests run one at a time (`workers: 1`): there is one owner, one ChatGPT session and one fake port.

`pnpm test` runs unit, module, api and component tests; `pnpm test:e2e` runs the e2e tests (one file: `pnpm test:e2e -- e2e/chat.e2e.test.ts`; through turbo, so `@repo/openai-subscription` is built first). Component and e2e tests need Chromium: run `pnpm --filter @repo/core exec playwright install chromium` once and after a Playwright upgrade (it downloads outside the repository, so the sandbox must be off).

# Dependencies

Ask before adding a dependency. First check whether Node.js, the platform or an existing dependency already covers the need.

# Before finishing

Run `pnpm format`, then `pnpm check-types`, `pnpm lint` and `pnpm test`, and report the result; when the change affects `apps/core` (pages, routes, `src/lib`), also run `pnpm test:e2e`. `check-types` and `test` accept a package filter (`pnpm test --filter=@repo/db`); `lint` (oxlint) and `format` (oxfmt) always cover the whole repository and take about a second. Do not call a change done while one of them fails.
