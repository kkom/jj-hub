import { afterAll, describe, expect, it } from "bun:test";

import { Effect, Layer, Option } from "effect";

import { Clipboard, type RichText } from "../../clients/clipboard";
import {
  type ListedPullRequest,
  PullRequestNumberSchema,
  type PullRequestState,
} from "../../clients/github/types";
import { fakeGitHub, inRepository } from "../../testing/fake-github";
import { removeScratchRepositories, scratchRepository } from "../../testing/scratch-repository";
import { htmlLinks, links, markdownLinks, NoPullRequests, stackPullRequests } from "./links";

afterAll(removeScratchRepositories);

const pullRequest = (number: number, state: PullRequestState, head: string): ListedPullRequest => ({
  head,
  number: PullRequestNumberSchema.make(number),
  state,
  title: `Pull request ${number}`,
  url: `https://github.com/kkom/jj-octo/pull/${number}`,
});

// A clipboard that keeps what is written to it.
const fakeClipboard = () => {
  const copied: RichText[] = [];
  const layer = Layer.succeed(Clipboard, {
    write: (content) =>
      Effect.sync(() => {
        copied.push(content);
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
      pullRequest(4, "closed", commitOf("d")),
      pullRequest(3, "draft", "anything"),
      pullRequest(2, "ready", "anything"),
      pullRequest(1, "merged", pushedA),
    ]);
  });
});

describe("markdownLinks and htmlLinks", () => {
  const listed = [
    pullRequest(4, "closed", "x"),
    pullRequest(3, "draft", "x"),
    pullRequest(2, "ready", "x"),
    { ...pullRequest(1, "merged", "x"), title: `Escape <b> & "quotes"` },
  ];

  it("writes a Markdown line per pull request, marked with its state", () => {
    expect(markdownLinks(listed)).toBe(
      [
        "🚫 [#4 Pull request 4](https://github.com/kkom/jj-octo/pull/4)",
        "📝 [#3 Pull request 3](https://github.com/kkom/jj-octo/pull/3)",
        "👀 [#2 Pull request 2](https://github.com/kkom/jj-octo/pull/2)",
        `✅ [#1 Escape <b> & "quotes"](https://github.com/kkom/jj-octo/pull/1)`,
      ].join("\n"),
    );
  });

  it("writes the same lines as HTML, escaping the titles", () => {
    expect(htmlLinks(listed)).toBe(
      [
        '<meta charset="utf-8">🚫 <a href="https://github.com/kkom/jj-octo/pull/4">#4 Pull request 4</a>',
        '📝 <a href="https://github.com/kkom/jj-octo/pull/3">#3 Pull request 3</a>',
        '👀 <a href="https://github.com/kkom/jj-octo/pull/2">#2 Pull request 2</a>',
        '✅ <a href="https://github.com/kkom/jj-octo/pull/1">#1 Escape &lt;b&gt; &amp; &quot;quotes&quot;</a>',
      ].join("<br>"),
    );
  });
});

describe("links", () => {
  it("copies the links as HTML and Markdown when asked", async () => {
    const repository = scratchRepository();
    repository.stack("a");
    const listed = pullRequest(1, "draft", "anything");
    const github = fakeGitHub({}, Option.none(), {
      pullRequestsFrom: (branch) => (branch === "a" ? [listed] : []),
    });
    const clipboard = fakeClipboard();
    await Effect.runPromise(
      links({ copy: true, revision: "@" }).pipe(
        Effect.provide(clipboard.layer),
        inRepository(repository, github),
      ),
    );
    expect(clipboard.copied).toStrictEqual([
      { html: htmlLinks([listed]), text: markdownLinks([listed]) },
    ]);
  });

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

  it("copies nothing unless asked", async () => {
    const repository = scratchRepository();
    repository.stack("a");
    const github = fakeGitHub({}, Option.none(), {
      pullRequestsFrom: () => [pullRequest(1, "draft", "anything")],
    });
    const clipboard = fakeClipboard();
    await Effect.runPromise(
      links({ copy: false, revision: "@" }).pipe(
        Effect.provide(clipboard.layer),
        inRepository(repository, github),
      ),
    );
    expect(clipboard.copied).toStrictEqual([]);
  });
});
