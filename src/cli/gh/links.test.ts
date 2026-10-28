import { afterAll, describe, expect, it } from "bun:test";

import { Effect, Layer, Option } from "effect";

import { Clipboard, type ClipboardWrite, type RichText } from "../../clients/clipboard";
import {
  type ListedPullRequest,
  PullRequestNumberSchema,
  type PullRequestState,
  StackNumberSchema,
} from "../../clients/github/types";
import { fakeConsole } from "../../testing/fake-console";
import { fakeGitHub, inRepository } from "../../testing/fake-github";
import { removeScratchRepositories, scratchRepository } from "../../testing/scratch-repository";
import {
  htmlLinks,
  type LinkedPullRequest,
  links,
  markdownLinks,
  NoPullRequests,
  stackPullRequests,
} from "./links";

afterAll(removeScratchRepositories);

const pullRequest = (number: number, state: PullRequestState, head: string): ListedPullRequest => ({
  head,
  number: PullRequestNumberSchema.make(number),
  stack: Option.none(),
  state,
  title: `Pull request ${number}`,
  url: `https://github.com/kkom/jj-octo/pull/${number}`,
});

// A pull request with the lines its change adds and removes, by default the one line of `stack`.
const linked = (listed: ListedPullRequest, added = 1, removed = 0): LinkedPullRequest => ({
  ...listed,
  added,
  removed,
});

// A clipboard that keeps what is written to it, and reports the given outcome.
const fakeClipboard = (outcome: ClipboardWrite = "copied") => {
  const copied: RichText[] = [];
  const layer = Layer.succeed(Clipboard, {
    write: (content) =>
      Effect.sync(() => {
        copied.push(content);
        return outcome;
      }),
  });
  return { copied, layer };
};

describe("stackPullRequests", () => {
  it("finds each change's pull request, top first", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b", "c", "d", "e", "f");
    const commitOf = (bookmark: string) =>
      repository.jj("log", "--no-graph", "-r", bookmark, "-T", "commit_id");
    repository.jj("git", "push", "--bookmark", "a");
    const pushedA = commitOf("a");
    repository.jj("describe", "-r", "a", "-m", "a, reworded");
    repository.write("a.txt", "a, rewritten\n");
    repository.write("d.txt", "d\nmore\nlines\n");
    repository.jj("squash", "--into", "d");
    const byBranch: Readonly<Record<string, readonly ListedPullRequest[]>> = {
      a: [pullRequest(1, "merged", pushedA)],
      b: [pullRequest(6, "closed", "an earlier head"), pullRequest(2, "ready", "anything")],
      c: [pullRequest(3, "draft", "anything")],
      d: [pullRequest(4, "closed", commitOf("d"))],
      e: [pullRequest(5, "merged", "a head from an earlier branch named e")],
    };
    const github = fakeGitHub({}, Option.none(), {
      pullRequestsFrom: (branch) => byBranch[branch] ?? [],
    });
    const found = await Effect.runPromise(
      stackPullRequests("@").pipe(inRepository(repository, github)),
    );
    expect(found).toStrictEqual([
      linked(pullRequest(4, "closed", commitOf("d")), 4, 1),
      linked(pullRequest(3, "draft", "anything")),
      linked(pullRequest(2, "ready", "anything")),
      linked(pullRequest(1, "merged", pushedA)),
    ]);
  });
});

describe("markdownLinks and htmlLinks", () => {
  const listed = [
    linked(pullRequest(4, "closed", "x"), 123, 45),
    linked(pullRequest(3, "draft", "x"), 0, 7),
    linked(pullRequest(2, "ready", "x")),
    { ...linked(pullRequest(1, "merged", "x")), title: `Escape <b> & "quotes"` },
  ];

  it("writes a Markdown line per pull request, marked with its state", () => {
    expect(markdownLinks(listed)).toBe(
      [
        "🚫 [#4 Pull request 4](https://github.com/kkom/jj-octo/pull/4) `+123/-45`",
        "📝 [#3 Pull request 3](https://github.com/kkom/jj-octo/pull/3) `+0/-7`",
        "👀 [#2 Pull request 2](https://github.com/kkom/jj-octo/pull/2) `+1/-0`",
        `🏁 [#1 Escape <b> & "quotes"](https://github.com/kkom/jj-octo/pull/1) \`+1/-0\``,
      ].join("\n"),
    );
  });

  it("writes the same lines as HTML, escaping the titles", () => {
    expect(htmlLinks(listed)).toBe(
      [
        '<meta charset="utf-8">🚫 <a href="https://github.com/kkom/jj-octo/pull/4">#4 Pull request 4</a> <code>+123/-45</code>',
        '📝 <a href="https://github.com/kkom/jj-octo/pull/3">#3 Pull request 3</a> <code>+0/-7</code>',
        '👀 <a href="https://github.com/kkom/jj-octo/pull/2">#2 Pull request 2</a> <code>+1/-0</code>',
        '🏁 <a href="https://github.com/kkom/jj-octo/pull/1">#1 Escape &lt;b&gt; &amp; &quot;quotes&quot;</a> <code>+1/-0</code>',
      ].join("<br>"),
    );
  });
});

// The pull request in GitHub stack `number`.
const inStack = (listed: LinkedPullRequest, number: number): LinkedPullRequest => ({
  ...listed,
  stack: Option.some({
    number: StackNumberSchema.make(number),
    url: `https://github.com/kkom/jj-octo/stack/${number}`,
  }),
});

describe("markdownLinks and htmlLinks with stacks", () => {
  // A stack registered again under a new number leaves its merged pull requests in the old one.
  const listed = [
    inStack(linked(pullRequest(3, "ready", "x")), 8),
    inStack(linked(pullRequest(2, "ready", "x")), 8),
    inStack(linked(pullRequest(1, "merged", "x")), 7),
  ];

  it("links each stack once, above the pull requests", () => {
    expect([markdownLinks(listed), htmlLinks(listed)]).toStrictEqual([
      [
        "📚 [Stack #8](https://github.com/kkom/jj-octo/stack/8)",
        "📚 [Stack #7](https://github.com/kkom/jj-octo/stack/7)",
        "👀 [#3 Pull request 3](https://github.com/kkom/jj-octo/pull/3) `+1/-0`",
        "👀 [#2 Pull request 2](https://github.com/kkom/jj-octo/pull/2) `+1/-0`",
        "🏁 [#1 Pull request 1](https://github.com/kkom/jj-octo/pull/1) `+1/-0`",
      ].join("\n"),
      [
        '<meta charset="utf-8">📚 <a href="https://github.com/kkom/jj-octo/stack/8">Stack #8</a>',
        '📚 <a href="https://github.com/kkom/jj-octo/stack/7">Stack #7</a>',
        '👀 <a href="https://github.com/kkom/jj-octo/pull/3">#3 Pull request 3</a> <code>+1/-0</code>',
        '👀 <a href="https://github.com/kkom/jj-octo/pull/2">#2 Pull request 2</a> <code>+1/-0</code>',
        '🏁 <a href="https://github.com/kkom/jj-octo/pull/1">#1 Pull request 1</a> <code>+1/-0</code>',
      ].join("<br>"),
    ]);
  });
});

describe("links", () => {
  it.each([
    ["copied", "copied the links to the clipboard"],
    [
      "unreachable",
      "This Claude Code cloud session can't reach the user's clipboard. Put the lines above in your reply exactly as printed, without adding backticks or a code block, so they show as links that paste into Slack.",
    ],
  ] as const)(
    "writes the links to the clipboard as HTML and Markdown when asked, and reports %s",
    async (outcome, report) => {
      const repository = scratchRepository();
      repository.stack("a");
      const listed = pullRequest(1, "draft", "anything");
      const github = fakeGitHub({}, Option.none(), {
        pullRequestsFrom: (branch) => (branch === "a" ? [listed] : []),
      });
      const clipboard = fakeClipboard(outcome);
      const console = fakeConsole();
      await Effect.runPromise(
        links({ copy: true, revision: "@" }).pipe(
          Effect.provide(clipboard.layer),
          inRepository(repository, github),
          console.provide,
        ),
      );
      expect({ copied: clipboard.copied, printed: console.printed }).toStrictEqual({
        copied: [{ html: htmlLinks([linked(listed)]), text: markdownLinks([linked(listed)]) }],
        printed: [
          { stream: "stdout", text: markdownLinks([linked(listed)]) },
          { stream: "stderr", text: report },
        ],
      });
    },
  );

  it("fails, copying nothing, where no change has a pull request", async () => {
    const repository = scratchRepository();
    repository.stack("a");
    const clipboard = fakeClipboard();
    const failure = await Effect.runPromise(
      Effect.flip(links({ copy: true, revision: "@" })).pipe(
        Effect.provide(clipboard.layer),
        inRepository(repository, fakeGitHub({}, Option.none())),
      ),
    );
    expect({ copied: clipboard.copied, failure }).toStrictEqual({
      copied: [],
      failure: new NoPullRequests({ message: "no change of the stack has a pull request" }),
    });
  });

  it("prints the GitHub stack the pull requests are in above them", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b");
    const github = fakeGitHub({}, Option.none(), {
      pullRequestsFrom: (branch) => [
        inStack(linked(pullRequest(branch === "a" ? 1 : 2, "ready", "anything")), 5),
      ],
    });
    const console = fakeConsole();
    await Effect.runPromise(
      links({ copy: false, revision: "@" }).pipe(
        Effect.provide(fakeClipboard().layer),
        inRepository(repository, github),
        console.provide,
      ),
    );
    expect(console.printed).toStrictEqual([
      {
        stream: "stdout",
        text: [
          "📚 [Stack #5](https://github.com/kkom/jj-octo/stack/5)",
          "👀 [#2 Pull request 2](https://github.com/kkom/jj-octo/pull/2) `+1/-0`",
          "👀 [#1 Pull request 1](https://github.com/kkom/jj-octo/pull/1) `+1/-0`",
        ].join("\n"),
      },
    ]);
  });

  it("copies nothing unless asked", async () => {
    const repository = scratchRepository();
    repository.stack("a");
    const listed = pullRequest(1, "draft", "anything");
    const github = fakeGitHub({}, Option.none(), { pullRequestsFrom: () => [listed] });
    const clipboard = fakeClipboard();
    const console = fakeConsole();
    await Effect.runPromise(
      links({ copy: false, revision: "@" }).pipe(
        Effect.provide(clipboard.layer),
        inRepository(repository, github),
        console.provide,
      ),
    );
    expect({ copied: clipboard.copied, printed: console.printed }).toStrictEqual({
      copied: [],
      printed: [{ stream: "stdout", text: markdownLinks([linked(listed)]) }],
    });
  });
});
