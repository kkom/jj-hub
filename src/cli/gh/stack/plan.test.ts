import { describe, expect, it } from "bun:test";

import { Option } from "effect";

import { PullRequestNumberSchema, StackNumberSchema } from "../../../clients/github/types";
import { pullRequests, stackOf } from "../../../testing/fake-github";
import {
  agreedDescription,
  basesFor,
  descriptionFrom,
  descriptionSyncFor,
  mustDissolve,
  normalizedDescription,
  registrationFor,
  titleAndBody,
} from "./plan";

describe("basesFor", () => {
  it("targets the trunk under the bottom and the branch below everywhere else", () => {
    expect(basesFor(["a", "b", "c"], "main")).toEqual(["main", "a", "b"]);
  });
});

const wanted = (...numbers: readonly (number | undefined)[]) =>
  numbers.map((number) =>
    number === undefined ? Option.none() : Option.some(PullRequestNumberSchema.make(number)),
  );

describe("mustDissolve", () => {
  it.each([
    {
      basesMove: false,
      dissolves: false,
      existing: Option.none(),
      order: wanted(1, 2),
      when: "no stack exists",
    },
    {
      basesMove: false,
      dissolves: false,
      existing: stackOf(1, 2),
      order: wanted(1, 2),
      when: "the stack is in the wanted order",
    },
    {
      basesMove: false,
      dissolves: false,
      existing: stackOf(1, 2),
      order: wanted(1, 2),
      when: "pull requests are added on top",
    },
    {
      basesMove: false,
      dissolves: false,
      existing: stackOf(1, 2, 3),
      order: wanted(1, 2),
      when: "only the bottom part is wanted",
    },
    {
      basesMove: false,
      dissolves: true,
      existing: stackOf(1, 2, 3),
      order: wanted(1, 3, 2),
      when: "the order changed",
    },
    {
      basesMove: false,
      dissolves: true,
      existing: stackOf(1, 2, 3),
      order: wanted(1, 3),
      when: "a change was dropped",
    },
    {
      basesMove: false,
      dissolves: true,
      existing: stackOf(1, 2),
      order: wanted(1, undefined, 2),
      when: "a change was inserted",
    },
    {
      basesMove: true,
      dissolves: true,
      existing: stackOf(1, 2),
      order: wanted(1, 2),
      when: "a base has to move",
    },
    {
      basesMove: false,
      dissolves: true,
      existing: stackOf(),
      order: wanted(4, 5),
      when: "every pull request of it merged",
    },
  ])("when $when", ({ basesMove, dissolves, existing, order }) => {
    expect(mustDissolve(existing, order, basesMove)).toBe(dissolves);
  });
});

describe("registrationFor", () => {
  it("creates a stack for two or more pull requests in none", () => {
    expect(registrationFor(Option.none(), pullRequests(1, 2))).toEqual({
      _tag: "Create",
      pullRequests: pullRequests(1, 2),
    });
  });

  it("registers nothing for a single pull request", () => {
    expect(registrationFor(Option.none(), pullRequests(1))).toEqual({ _tag: "Unchanged" });
  });

  it("leaves a stack that already holds the pull requests", () => {
    expect(registrationFor(stackOf(1, 2, 3), pullRequests(1, 2))).toEqual({ _tag: "Unchanged" });
  });

  it("appends pull requests added on top", () => {
    expect(registrationFor(stackOf(1, 2), pullRequests(1, 2, 3))).toEqual({
      _tag: "Append",
      pullRequests: pullRequests(3),
      stack: StackNumberSchema.make(7),
    });
  });
});

describe("titleAndBody", () => {
  it("takes the first line as the title and the rest as the body", () => {
    expect(titleAndBody("Add a thing\n\nBecause.\n\nTrailer: x\n")).toStrictEqual({
      body: "Because.\n\nTrailer: x",
      title: "Add a thing",
    });
  });

  it("keeps the indent of the body's first line", () => {
    expect(titleAndBody("Add a thing\n\n  \n    code\nmore")).toStrictEqual({
      body: "    code\nmore",
      title: "Add a thing",
    });
  });
});

// Every description of up to four lines built from these, which covers blank, indented and
// whitespace-only lines in each position.
const lineKinds = ["", "  ", "Text", "    code", "\tcode", "  - nested", "Text  "];
const withLine = (prefixes: readonly string[]): string[] =>
  prefixes.flatMap((prefix) => lineKinds.map((line) => `${prefix}\n${line}`));
const twoLines = withLine(lineKinds);
const threeLines = withLine(twoLines);
const descriptions = [...lineKinds, ...twoLines, ...threeLines, ...withLine(threeLines)];

/** The non-blank lines of a description, without the whitespace at its end. */
const contentLines = (description: string): string =>
  description
    .trimEnd()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n");

const roundTrip = (description: string): string => descriptionFrom(titleAndBody(description));

describe("titleAndBody and descriptionFrom", () => {
  it("change a description at most once, in its blank lines and the whitespace at its end", () => {
    const changed = descriptions.filter((description) => {
      const once = roundTrip(description);
      return roundTrip(once) !== once || contentLines(once) !== contentLines(description);
    });
    expect(changed).toStrictEqual([]);
  });

  it("give back a pull request's title and a body that starts and ends with text", () => {
    const bodies = descriptions.filter(
      (body) => body === body.trimEnd() && body.split("\n")[0]?.trim() !== "",
    );
    const titled = ["", "Title"].flatMap((title) => bodies.map((body) => ({ body, title })));
    const changed = titled.filter(
      (pullRequest) => !Bun.deepEquals(titleAndBody(descriptionFrom(pullRequest)), pullRequest),
    );
    expect(changed).toStrictEqual([]);
  });
});

describe("normalizedDescription", () => {
  const plain = { ignoreClaudeCodeFooter: false };
  const ignoringFooter = { ignoreClaudeCodeFooter: true };

  it("reads GitHub's line endings and jj's trailing newline as the same text", () => {
    expect(normalizedDescription("A title\r\n\r\nWhy.\r\n", plain)).toBe("A title\n\nWhy.");
    expect(normalizedDescription("A title\n\nWhy.\n", plain)).toBe("A title\n\nWhy.");
  });

  it("keeps the indent of a body's first line with GitHub's line endings", () => {
    expect(normalizedDescription("A title\r\n\r\n  \r\n    code\r\n", plain)).toBe(
      "A title\n\n    code",
    );
  });

  const withFooters = [
    "A title\n\nWhy.\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_",
    "A title\r\n\r\nWhy.\r\n\r\n---\r\n_Generated by [Claude Code](https://claude.ai/code/session_01AbC)_\r\n",
  ];

  it.each(withFooters)(
    "leaves out the Claude Code proxy's footer in %p when told to",
    (description) => {
      expect(normalizedDescription(description, ignoringFooter)).toBe("A title\n\nWhy.");
    },
  );

  it("keeps the Claude Code proxy's footer by default", () => {
    expect(
      normalizedDescription(
        "A title\n\nWhy.\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_",
        plain,
      ),
    ).toBe("A title\n\nWhy.\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_");
  });

  it("keeps the same footer anywhere but at the end", () => {
    const description =
      "A title\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_\n\nWhy.";
    expect(normalizedDescription(description, ignoringFooter)).toBe(description);
  });
});

describe("agreedDescription", () => {
  const cases = [
    {
      expected: "record",
      input: { isOwnEarlier: false, onGitHub: "pushed", recorded: Option.some("record") },
      name: "the record, over the pushed description that GitHub has",
    },
    {
      expected: "record",
      input: { isOwnEarlier: true, onGitHub: "github", recorded: Option.some("record") },
      name: "the record",
    },
    {
      expected: "github",
      input: { isOwnEarlier: true, onGitHub: "github", recorded: Option.none() },
      name: "GitHub's description, which the change had before",
    },
    {
      expected: "pushed",
      input: { isOwnEarlier: false, onGitHub: "github", recorded: Option.none() },
      name: "the pushed description",
    },
  ] as const;
  for (const { expected, input, name } of cases) {
    it(`is ${name}`, () => {
      expect(agreedDescription({ ...input, pushed: "pushed" })).toBe(expected);
    });
  }
});

describe("descriptionSyncFor", () => {
  it.each([
    ["InSync", "new", "new"],
    ["TakeGitHub", "old", "new"],
    ["SendLocal", "new", "old"],
    ["Merge", "mine", "theirs"],
  ] as const)("is %s for local %p and GitHub %p, agreed as old", (tag, local, onGitHub) => {
    expect(descriptionSyncFor({ agreed: "old", local, onGitHub })).toStrictEqual({ _tag: tag });
  });
});
