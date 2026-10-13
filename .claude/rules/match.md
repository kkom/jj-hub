---
paths:
  - "**/*.{ts,tsx}"
---

# Matching a discriminated union

## Branch with `Match` and `Match.exhaustive`

Use Effect's `Match.value(...).pipe(Match.when(...), Match.exhaustive)`.

❌ Not an `if` chain, and not a `switch` with a `default` that quietly absorbs the case nobody thought about.

`Match.exhaustive` makes an unhandled variant a **compile error**, so adding one to the union points at every place that now has to say what it means. An `if` chain falls through to its last branch instead, so the new variant gets another variant's result and nothing reports it.

```ts
return Match.value(shape).pipe(
  Match.when({ kind: "circle" }, (circle) => Math.PI * circle.radius ** 2),
  Match.when({ kind: "rectangle" }, (rectangle) => rectangle.width * rectangle.height),
  // Variants that share a result are listed together rather than defaulted.
  Match.whenOr({ kind: "line" }, { kind: "point" }, () => 0),
  Match.exhaustive,
);
```

Each handler receives the **narrowed** member, so `circle.radius` is reachable without a cast.

## Use `Match.orElse` only for open input

Where the input is genuinely open-ended — a string from the wire, a keyword we don't model. ❌ Never as a shortcut past variants we own: if our own union grows, we want the compiler to fail on each unhandled variant.

## Parse unknown input with a schema

`Match` matches a value whose type is already known. It doesn't validate an `unknown` off the network.
