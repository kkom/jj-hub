import { Schema } from "effect";

import { responseOf } from "./openapi";
import { type ListedPullRequest, PullRequestNumberSchema, StackNumberSchema } from "./types";

// The fields read from each GitHub response the client decodes.

export const CreatedPullRequest = responseOf<"pulls/create">()(
  Schema.Struct({ number: PullRequestNumberSchema }),
);
export const CreatedStack = responseOf<"pull-request-stacks/create">()(
  Schema.Struct({ number: StackNumberSchema }),
);
export const PullRequests = responseOf<"pulls/list">()(
  Schema.Array(
    Schema.Struct({
      base: Schema.Struct({ ref: Schema.String }),
      body: Schema.NullOr(Schema.String),
      draft: Schema.optionalKey(Schema.Boolean),
      number: PullRequestNumberSchema,
      title: Schema.String,
    }),
  ),
);
export const AnyPullRequests = responseOf<"pulls/list">()(
  Schema.Array(
    Schema.Struct({
      draft: Schema.optionalKey(Schema.Boolean),
      head: Schema.Struct({ sha: Schema.String }),
      html_url: Schema.String,
      merged_at: Schema.NullOr(Schema.String),
      number: PullRequestNumberSchema,
      state: Schema.String,
      title: Schema.String,
    }),
  ),
);
const StackedPullRequest = Schema.Struct({
  number: PullRequestNumberSchema,
  state: Schema.Literals(["closed", "open"]),
});
export const Stacks = responseOf<"pull-request-stacks/list">()(
  Schema.Array(
    Schema.Struct({ number: StackNumberSchema, pull_requests: Schema.Array(StackedPullRequest) }),
  ),
);
export const RepositoryDetails = responseOf<"repos/get">()(
  Schema.Struct({ default_branch: Schema.String }),
);
const MergeRequest = Schema.Struct({
  details: Schema.Struct({
    message: Schema.String,
    uuid: Schema.optionalKey(Schema.String),
  }),
  status: Schema.Literals(["enqueued", "failed", "merged", "pending"]),
});
export const StartedMerge = responseOf<"pulls/merge-async">()(MergeRequest);
export const MergeResult = responseOf<"pulls/get-merge-async-result">()(MergeRequest);

/** One pull request of an `AnyPullRequests` listing, with its state in one value. */
export const listedPullRequest = ({
  draft,
  head,
  html_url,
  merged_at,
  number,
  state,
  title,
}: (typeof AnyPullRequests.Type)[number]): ListedPullRequest => {
  const open = draft === true ? "draft" : "ready";
  const closed = merged_at === null ? "closed" : "merged";
  return { head: head.sha, number, state: state === "open" ? open : closed, title, url: html_url };
};
