import { describe, expect, it } from "bun:test";

import { listedPullRequest, remoteStack } from "./responses";
import { PullRequestNumberSchema, type PullRequestState, StackNumberSchema } from "./types";

const listed = (state: string, draft: boolean | undefined, mergedAt: string | null) => ({
  ...(draft === undefined ? {} : { draft }),
  head: { sha: "abc" },
  html_url: "https://github.com/kkom/jj-octo/pull/1",
  merged_at: mergedAt,
  number: PullRequestNumberSchema.make(1),
  state,
  title: "Add a",
});

const link = (state: PullRequestState) => ({
  head: "abc",
  number: PullRequestNumberSchema.make(1),
  state,
  title: "Add a",
  url: "https://github.com/kkom/jj-octo/pull/1",
});

const stacked = (number: number, mergedAt: string | null) => ({
  merged_at: mergedAt,
  number: PullRequestNumberSchema.make(number),
});

describe("listedPullRequest", () => {
  it("reads an open pull request as a draft or ready for review", () => {
    expect(listedPullRequest(listed("open", true, null))).toEqual(link("draft"));
    expect(listedPullRequest(listed("open", false, null))).toEqual(link("ready"));
    expect(listedPullRequest(listed("open", undefined, null))).toEqual(link("ready"));
  });

  it("reads a closed pull request as merged or closed unmerged", () => {
    expect(listedPullRequest(listed("closed", false, "2026-10-24T12:00:00Z"))).toEqual(
      link("merged"),
    );
    expect(listedPullRequest(listed("closed", false, null))).toEqual(link("closed"));
  });
});

describe("remoteStack", () => {
  // GitHub keeps a pull request closed without merging in its stack, and adds only above the top.
  it("keeps every pull request that hasn't merged, closed or open, and leaves out a merged one", () => {
    expect(
      remoteStack({
        number: StackNumberSchema.make(7),
        pull_requests: [stacked(1, "2026-10-24T12:00:00Z"), stacked(2, null), stacked(3, null)],
      }),
    ).toEqual({
      number: StackNumberSchema.make(7),
      unmerged: [PullRequestNumberSchema.make(2), PullRequestNumberSchema.make(3)],
    });
  });
});
