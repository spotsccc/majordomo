---
name: error-as-value
description: Errors-as-values convention for TypeScript code in packages that depend on @spotsccc/error-as-value (functions return `Error | T`, callers narrow with `instanceof Error`, tagged errors via createTaggedError, tryFn/tryAsync, matchError, findCause, isAbortError). Use when writing, refactoring, or reviewing error handling in such a package — typed errors, wrapping throwing third-party/IO boundaries, cause chains, cancellation. Use ONLY when the package.json of the workspace package that owns the code lists @spotsccc/error-as-value, or that code already imports it. Do not use in projects without this dependency, even if they return `Error | T`, and never use it to introduce the library or migrate an existing error model unless the user explicitly asks.
---

# Error as Value

## Gate — check before applying anything below

Workspace `package.json` files that declare `@spotsccc/error-as-value`, relative to the repository root (`(none)` = not found):

!`git grep -l --full-name --untracked -F '"@spotsccc/error-as-value"' -- ':/*package.json' 2>/dev/null || grep -l -F '"@spotsccc/error-as-value"' package.json 2>/dev/null || echo "(none)"`

If a raw command or an error appears above instead of a list (shell execution in skills disabled or denied), run that command yourself with Bash before continuing.

1. If the list is `(none)` and the code you are touching does not import `@spotsccc/error-as-value`, stop using this skill and follow the repository's existing error model.
2. In a monorepo, apply the convention only inside packages from the list (or packages that already import the library). Do not spread it into other packages, and do not add the dependency unless the user asked.
3. Do not rely on memory for the API. When unsure about a signature, read the installed types: `node_modules/@spotsccc/error-as-value/dist/*.d.ts` (in pnpm workspaces resolve from the owning package, e.g. `<package>/node_modules/@spotsccc/error-as-value`). Installed types win over the examples below.
4. Before creating an error class, look for a shared errors package or module in the repository (for example a workspace package that re-exports domain errors built on this library) and reuse its errors.

## Convention

Functions return `Error | T`, callers narrow with `instanceof Error`, and expected failures do not throw.

```ts
const user = await getUser(id);
if (user instanceof Error) return user;

return user.name;
```

## Core rules

1. Follow the repository's existing error conventions. Import only the symbols in use directly from `@spotsccc/error-as-value`.
2. Return expected failures as `Error | T`. Throw only at a boundary whose contract requires exceptions (framework handlers, callbacks that must throw) or for truly unexpected programmer failures.
3. Handle errors immediately with an early exit. Keep the success path at the root indentation level.
4. Convert exceptions to values once, at the lowest uncontrolled boundary: third-party libraries, `fetch`, file I/O, parsing, environment access, or legacy throwing code.
5. Preserve the original failure with `cause` when wrapping it.
6. Do not return `unknown | Error`; the union collapses to `unknown`. Parse or type uncontrolled data before returning it.
7. Use `null` for an expected absence when the repository distinguishes absence from failure: `Error | T | null`.

## Design errors without overengineering

Default to no new error class.

Before defining an error, identify its current consumer. Create a tagged error only when at least one current requirement needs it:

- a caller branches on this exact failure;
- an HTTP, UI, or job boundary maps it differently;
- recovery or accounting needs structured data from it;
- telemetry needs a stable tag or fingerprint;
- no existing error accurately represents the domain failure.

Otherwise propagate the existing error or reuse the nearest existing domain error.

Do not create an error class only to:

- prepend text to another error;
- copy `cause.message` into `$detail`;
- represent every individual `.catch()` call;
- wrap an already suitable domain error at another internal layer;
- prepare for hypothetical future handling.

Every wrapper must add actionable context for a current consumer. Do not wrap the same failure at every layer.

Add a property only when current code reads or serializes it. Search usages (Grep) before adding fields or a custom constructor. Template variables are for meaningful domain values, not for duplicating the cause message.

## Choose the smallest representation

### Propagate an existing error

```ts
const media = await uploadMedia(input);
if (media instanceof Error) return media;
```

### Define a simple tagged error

Use a class without a constructor when callers need a distinct failure but no extra data.

```ts
import { createTaggedError } from '@spotsccc/error-as-value';

class UserLookupError extends createTaggedError({
  name: 'UserLookupError',
  message: 'Failed to look up user',
}) {}

const user = await lookupUser(id).catch(
  (cause) => new UserLookupError({ cause }),
);
```

The `cause` already preserves the underlying message and stack. Do not add `$detail` only to repeat `cause.message`.

### Use template properties for domain context

`$variables` in `message` become required constructor props and are interpolated into the message.

```ts
import { createTaggedError } from '@spotsccc/error-as-value';

class NotFoundError extends createTaggedError({
  name: 'NotFoundError',
  message: 'User $id not found',
}) {}

return new NotFoundError({ id });
```

`id` is justified when it is useful for the message, matching, serialization, or handling.

### Add a custom constructor only for required structured data

```ts
import { createTaggedError } from '@spotsccc/error-as-value';

class AssetUploadError extends createTaggedError({
  name: 'AssetUploadError',
  message: 'Failed to upload asset',
}) {
  readonly bytesTransferred: number;

  constructor(args: { bytesTransferred: number; cause: unknown }) {
    super({ cause: args.cause });
    this.bytesTransferred = args.bytesTransferred;
  }
}
```

This complexity is justified only if a current caller uses `bytesTransferred`. Do not move such data into a broader result wrapper unless that representation makes the current flow simpler.

## Convert throwing boundaries

For an async boundary, attach `.catch()` directly to the throwing promise. Reuse an existing error when possible; otherwise create one coarse error for the operation, not one class per technical step.

```ts
const response = await fetch(url).catch(
  (cause) => new NetworkError({ url, cause }),
);
if (response instanceof Error) return response;
```

When the throwing code is not a single promise expression (it may throw synchronously before returning a promise, or spans several awaits), use `tryAsync(fn, catchFn)` instead.

For a synchronous boundary, use `tryFn(fn, catchFn)`. Without `catchFn` it returns `UnhandledError | T`.

```ts
import { tryFn } from '@spotsccc/error-as-value';

const config = tryFn(
  () => ConfigSchema.parse(JSON.parse(raw)),
  (cause) => new ConfigParseError({ cause }),
);
if (config instanceof Error) return config;
```

Do not add `.catch()` or `tryAsync` around internal functions that already return errors as values.

When a boundary only needs a generic failure, a plain `Error` with `cause` is valid. A tagged class is not mandatory:

```ts
const result = await dependencyCall().catch(
  (cause) => new Error('Dependency call failed', { cause }),
);
```

## Handle results

Prefer direct checks and early exits:

```ts
const user = await getUser(id);
if (user instanceof Error) return user;

const posts = await getPosts(user.id);
if (posts instanceof Error) return posts;

return render(user, posts);
```

For parallel operations, check each result before using any success value:

```ts
const [user, posts] = await Promise.all([getUser(id), getPosts(id)]);
if (user instanceof Error) return user;
if (posts instanceof Error) return posts;

return { user, posts };
```

Log an error only when it is intentionally not propagated. Do not log at every layer because that duplicates reports.

## Matching and causes

Use `matchError` only when several error types genuinely map to different outcomes. Include the `Error` fallback required for untagged errors. Use `matchErrorPartial` with a fallback when only some tags need distinct handling.

Use `error.findCause(ErrorClass)` on errors created by `createTaggedError`. Use `findCause(error, ErrorClass)` for any `Error`. Do not copy cause fields into every wrapper for convenience.

## Cancellation

Use `isAbortError(error)` instead of checking `error.name`. It walks the cause chain.

If providing a custom abort reason, extend `AbortError` so wrapped cancellation remains detectable:

```ts
import { AbortError, createTaggedError } from '@spotsccc/error-as-value';

class TimeoutError extends createTaggedError({
  name: 'TimeoutError',
  message: 'Request timed out',
  extends: AbortError,
}) {}
```

Check cancellation before expensive side effects and after awaited calls that receive the signal. Keep abort and generic error checks separate when they have different handling.

## Verify

Run the owning package's typecheck (and its tests if behavior changed). The convention relies on the type system: a missing `instanceof Error` check usually surfaces as a type error on the success path.

## Review checklist

- Does each expected failure appear in the return type?
- Is every exception converted at the lowest uncontrolled boundary?
- Can an existing error be propagated instead of wrapped?
- Does every new error class have a current consumer?
- Does every custom property have a current reader or serialization contract?
- Is `cause` preserved without copying its message into `$detail`?
- Is the error logged only where it is swallowed or finally handled?
- Can any wrapper, constructor, field, or branch be deleted while preserving behavior?
