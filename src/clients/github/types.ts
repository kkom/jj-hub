import { Schema } from "effect";

export const PullRequestNumberSchema = Schema.Number.pipe(Schema.brand("PullRequestNumber"));
export type PullRequestNumber = typeof PullRequestNumberSchema.Type;

export const StackNumberSchema = Schema.Number.pipe(Schema.brand("StackNumber"));
export type StackNumber = typeof StackNumberSchema.Type;

export interface PullRequest {
  readonly base: string;
  readonly body: string;
  readonly draft: boolean;
  readonly number: PullRequestNumber;
  readonly title: string;
}

/** Where a pull request is: open as a draft or ready for review, merged, or closed unmerged. */
export type PullRequestState = "closed" | "draft" | "merged" | "ready";

/** A pull request from a branch, in any state, with its head commit, title and address. */
export interface ListedPullRequest {
  readonly head: string;
  readonly number: PullRequestNumber;
  readonly state: PullRequestState;
  readonly title: string;
  readonly url: string;
}

/** A stack registered on GitHub, with its open pull requests bottom to top. */
export interface RemoteStack {
  readonly number: StackNumber;
  readonly open: readonly PullRequestNumber[];
}
