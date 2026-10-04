---
name: minimal-mock-testing
description: Test-design policy "mock uncontrollability, not dependencies". Use when writing new tests or a test harness, choosing test scope (unit / integration / e2e), deciding whether to mock, fake, or use a real dependency (database, filesystem, sockets, RPC, CLI, browser, daemon, external API), or reviewing mock-heavy, flaky, or boundary-focused tests. Skip for routine edits to simple isolated tests where no dependency-boundary trade-off exists.
---

# Minimal Mock Testing

## Principle

Mock uncontrollability, not dependencies.

Prefer tests that exercise real interactions across code owned by the project. Replace only the
parts of the world that cannot be made deterministic, local, cheap, or safe enough for the test.

## Test Scope

Use the smallest scope that covers the risk, but do not shrink the scope by mocking project-owned
behavior that is part of that risk.

- **Unit tests**: Cover small logic units with no real infrastructure. Pure functions are ideal, but
  a unit may still use simple fakes for collaborators. Assert observable behavior, not private call
  choreography.
- **Integration/component tests**: Cover project modules working together with controlled
  infrastructure. Use real databases, migrations, filesystem temp dirs, sockets, RPC framing,
  queues, config files, clocks, and local processes when they are practical to control.
- **End-to-end tests**: Cover a user/client-visible flow through public interfaces such as a
  browser, CLI, TUI, daemon socket, chat-bot channel, or other client boundary. Keep them few,
  high-value, and focused on critical journeys.

## Mocking Policy

Default to real controlled dependencies.

- Do not mock project-owned modules by default. A narrow mock is appropriate at an intentional
  architectural boundary when the subject is the adapter itself—for example, mock a domain service
  in a route-handler test that verifies request parsing, authorization, and HTTP mapping. Test the
  service's behavior separately at its own appropriate scope.
- Do not mock the database when engine behavior, schema, migrations, transactions, constraints, or
  queries are part of the risk. Use an isolated instance of the same database engine. A temporary
  SQLite database is appropriate only when production uses SQLite or the tested contract is
  deliberately engine-agnostic; it is not a substitute for PostgreSQL-specific SQL, migrations,
  constraints, transactions, locking, or concurrency.
- Do not duplicate protocol/framing behavior in tests; exercise the shared implementation.
- Prefer fake external services at the protocol boundary over function-level mocks inside the
  system. For HTTP APIs, run a local fake server or use a request interceptor (e.g. MSW) that
  validates real requests and returns contract-shaped responses.
- Mock or fake external APIs, third-party services, network boundaries, payment providers,
  LLM/model provider APIs, hosted auth services, and other systems the test cannot control.
- Mock nondeterminism when needed: time, random IDs, clocks, scheduling, rate limits, and rare OS or
  network failures.
- Use narrow mocks for hard-to-trigger failure paths such as permission denied, broken pipe,
  malformed upstream response, timeout, corrupt input, or connection reset.

## Test Harness Requirements

When real controlled dependencies provide material fidelity, reuse or improve the existing harness
instead of hiding the integration behind mocks.

- Before adding infrastructure, read the repository's testing instructions (CLAUDE.md, AGENTS.md,
  CONTRIBUTING, package READMEs) and inspect existing test configs (vitest/jest/playwright configs,
  global setup files), fixtures, factories, docker/compose services, and harness helpers. Reuse or
  extend them. In a large repository, delegate this survey to an Explore subagent and ask only for
  the harness entry points and conventions.
- Create isolated temp directories, databases, sockets, ports, environment variables, and home/data
  directories per test or suite.
- Seed fixtures through public or near-public setup paths where feasible: migrations, repositories,
  RPC calls, CLI commands, or domain services.
- Make time, randomness, IDs, and background work deterministic when the assertion depends on them.
- Capture useful diagnostics: logs, subprocess stderr/stdout, request/response traces, DB path,
  socket path, and cleanup failures.
- Clean up explicitly, but never make cleanup errors silent when they can hide leaks or corruption.
- Keep E2E environments reproducible enough to run locally and in CI.
- If the harness needs something the session cannot provide (a running database container, network
  access, local port binding blocked by the sandbox), say so and give the user the command to run
  rather than silently falling back to mocks.

## Decision Workflow

Before adding or changing a test:

1. Read the repository's test guidance and identify the existing test infrastructure.
2. Identify the user-visible behavior or failure risk the test protects.
3. List the dependencies involved.
4. Classify each dependency as controlled, controllable with harness work, or uncontrolled.
5. Use a real implementation when its behavior is part of the risk and its setup, runtime, CI cost,
   and diagnostic quality are proportionate.
6. Put fakes or mocks at uncontrolled boundaries, intentional architectural boundaries outside the
   test subject, or points used for deliberate fault injection.
7. Choose the narrowest test scope that still exercises the important real interaction.
8. Run the test and verify it fails clearly when the behavior is broken. In order of preference:
   write the test before the fix and watch it fail; otherwise revert only the change you just made
   and re-run; as a last resort, temporarily break the behavior by hand and restore it. Never use
   `git stash` or `git checkout` on files with uncommitted changes for this. Report the exact
   commands and outcomes; never claim a test passes or guards a regression without having run it.

When the scope or harness choice is a real trade-off (e.g. spinning up a database container vs. a
narrower unit test), state the choice and the reason in one or two lines before implementing.

## Smells

Reconsider the test design when:

- It asserts that internal methods were called instead of asserting the resulting behavior.
- It mocks project-owned behavior that is part of the risk under test, or the mocked implementation
  has no separate behavioral coverage.
- It reimplements production protocol rules in the test.
- It is green even if the real dependency wiring is broken.
- It needs many mocks to describe a simple scenario.
- It is flaky because it depends on wall-clock time, real internet, shared state, or unordered
  background work.

## Review Standard

When reviewing tests, prioritize whether the test exercises the real contract, controls the
environment deterministically, and fails with a useful signal. Prefer a heavier harness only when
its additional fidelity covers a material risk and remains proportionate to setup complexity,
runtime, flakiness, CI resources, and diagnostic quality.
