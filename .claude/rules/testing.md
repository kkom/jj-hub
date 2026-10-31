# Tests

Applies to every language.

## Prefer fakes to stubs and mocks

A fake is a working implementation with a shortcut, such as an in-memory store in place of a database. A stub returns canned answers, and a mock records calls for the test to check. Use a fake, and use a stub or a mock only where no fake can stand in.

That's because a fake behaves like the real dependency, so the test checks outcomes and still passes after a refactor. A stub or a mock encodes how the code calls its dependency. It fails when those calls change, and passes when the real dependency would fail.

- ❌ A mocked repository that returns a canned row, and an assertion on the query it received
- ✅ An in-memory repository the test writes rows to, and an assertion on what the code reads back
- ❌ A mock asserting that `send` was called once with a given message
- ✅ A fake mailer that keeps sent messages in a list the test reads

## Make a fake do what the real dependency does

A fake answers as its documentation and real responses show the real dependency does. It adds no shortcut, default or failure response that the real one lacks. A test helper takes each step as a client would, and fails in the test's own code.

That's because a test can pass against a fake that differs, while production fails.

- ✅ A fake sign-in service that asks a person in several organizations to pick one, as the real one does
- ❌ A fake that signs that person in to no organization
- ❌ A response the fake sends only to tell a test helper that something failed

## Inject dependencies the way the framework does

Give code its dependencies through the framework's own dependency injection, such as an Effect layer or a constructor parameter. The test then provides the fake in the same place where production provides the real implementation.

That's because patching a module, with `vi.mock` or `unittest.mock.patch`, replaces it for everything that imports it.

- ❌ `vi.mock("./mailer")` to capture sent messages
- ✅ A fake mailer, provided through the test's layer in place of the real one

## Assert on complete objects

Compare the whole value in one equality assertion, rather than checking its fields one at a time or matching part of it.

That's because one comparison shows the expected value in one place, and fails on a field the test didn't think to check.

- ❌ `expect(user.name).toBe("Ada")`, then `expect(user.role).toBe("admin")`
- ❌ `expect(user).toMatchObject({ name: "Ada" })`
- ✅ `expect(user).toStrictEqual({ id: created.id, name: "Ada", role: "admin" })`

## Write dynamic values into the expected value, or match them

Where a field holds a value that differs on each run, such as a generated id or a timestamp, read it from the setup or the result, and write it into the expected value.

Otherwise, put a matcher in that field: an asymmetric matcher in vitest or Jest, or a dirty-equals type in Python. Choose the most specific matcher that fits. Still write the value in if that's easy, or if the exact value matters to the test.

That's because a written-in value checks the field exactly. A matcher also keeps the comparison whole, but it accepts some wrong values.

- ✅ `expect(row).toStrictEqual({ id: created.id, name: "Ada", createdAt: now })`
- ❌ `id: expect.any(String)`, where the test already has `created.id`
- ✅ `requestId: expect.stringMatching(UUID)`, where the code generates the id internally and the test isn't about it
- ✅ `assert event == {"id": IsUUID, "sent_at": IsNow(tz="UTC")}` in Python

## Disable the TypeScript lint ban only for a deliberate use

In TypeScript, oxlint's `no-restricted-properties` and `no-restricted-imports` rules fail on these, in any file:

- Partial matchers: `toMatchObject`, `objectContaining` and `arrayContaining`.
- Mock-call matchers: `toHaveBeenCalled`, `toHaveBeenCalledTimes`, `toHaveBeenCalledWith`, `toHaveBeenLastCalledWith`, `toHaveBeenNthCalledWith`, `toHaveReturned`, `toHaveReturnedTimes`, `toHaveReturnedWith`, `toHaveLastReturnedWith` and `toHaveNthReturnedWith`.
- Mocking APIs: `vi.mock`, `vi.doMock`, `vi.fn` and `vi.spyOn`, and `mock` and `spyOn` imported from `bun:test`.

Where a test needs one of them, disable the rule on that line, and say why in the comment. That's because the comment tells a reviewer the use is deliberate, rather than a check someone skipped.

- ❌ `// oxlint-disable-next-line no-restricted-properties`
- ✅ `// oxlint-disable-next-line no-restricted-properties -- the patched comparison inside objectContaining is what's tested`
