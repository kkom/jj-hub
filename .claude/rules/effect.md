---
paths:
  - "**/*.{ts,tsx}"
---

# Effect

`effect` is the standard library here for typed errors, schemas and effectful composition.

## Use the unstable modules too

`effect/*` (http, http-api, cli, …) is in bounds. Unstable means the API may shift between releases, not that it's off limits — a version bump that breaks something shows up as type errors, and that cost is accepted.

## Look in `effect` before writing a helper

Core modules first, then unstable. Base64, schema decoding, HTTP clients, retry policies, command-line parsing, credential parsing: the library ships them, and a hand-rolled copy re-derives edge cases it already handles.

## Prefix a module named after a global

`String`, `Number`, `Array`, `Date`: imported bare, the module shadows the global for the whole file — a type error where the names collide, and a silent bug where they don't.

✅ `import { String as EffectString } from "effect"`

## Retry with a `Schedule`, release with `acquireUseRelease`

- Waiting and retrying: a `Schedule` passed to `Effect.retry`, with `while` naming the failures worth waiting out. ❌ Not a recursive helper counting attempts down.
- Acquire/use/release: `Effect.acquireUseRelease`, which releases once and on interruption. ❌ Not a release repeated across `try` and `catch`.

## Ask for dependencies through the R channel

Yield a `Context.Service` rather than threading a first parameter, so adding a dependency doesn't edit everything between it and the entry point. Provide it once, where the program is run.

## Send outbound HTTP through `HttpClient`

From `effect/http`, with `FetchHttpClient.layer` provided at the entry point. ❌ Not bare `fetch`.

## Build a CLI with `Command`

From `effect/cli`, run with its runtime's platform services. An invocation the CLI can't make sense of is a `CliError.UserError`, so it's rendered like a bad flag rather than as a thrown stack trace.

## Parse `unknown` with `Schema`

Decoded types are readonly by construction, so they need no wrapper for the readonly-parameters rule.

Code that still validates with another schema library keeps it until it's migrated. ❌ Don't advertise one schema and validate with another.

## Use the real type where Effect code meets other code

If you're tempted to wrap a value in `Promise.resolve` or an `async` function, narrow the type instead. A genuinely asynchronous API is different: its real type is a promise. Convert it with `tryPromise` wherever the call can reject with a failure the caller can act on, and with `Effect.promise` only where every rejection is a defect, leaving the failure channel `never`.
