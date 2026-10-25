import { afterAll, describe, expect, it } from "bun:test";

import { Effect, Option } from "effect";

import {
  type ListedPullRequest,
  PullRequestNumberSchema,
  type PullRequestState,
} from "../../clients/github/types";
import { fakeGitHub, inRepository } from "../../testing/fake-github";
import { removeScratchRepositories, scratchRepository } from "../../testing/scratch-repository";
import { links } from "./links";

afterAll(removeScratchRepositories);

const pullRequest = (number: number, state: PullRequestState, head: string): ListedPullRequest => ({
  head,
  number: PullRequestNumberSchema.make(number),
  state,
  title: `Pull request ${number}`,
  url: `https://github.com/kkom/jj-octo/pull/${number}`,
});

const line = (emoji: string, number: number): string =>
  `${emoji} [#${number} Pull request ${number}](https://github.com/kkom/jj-octo/pull/${number})`;

describe("links", () => {
  it("links each change's pull request top first, marked with its state", async () => {
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
    const printed = await Effect.runPromise(links("@").pipe(inRepository(repository, github)));
    expect(printed).toEqual([line("🚫", 4), line("📝", 3), line("👀", 2), line("✅", 1)]);
  });
});
