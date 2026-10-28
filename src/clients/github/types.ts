import { type Option, Schema } from "effect";

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

/** A stack registered on GitHub, with the address of its page. */
export interface StackLink {
  readonly number: StackNumber;
  readonly url: string;
}

/**
 * A pull request from a branch, in any state, with its head commit, title and address, and the
 * stack it is in, where it is in one.
 */
export interface ListedPullRequest {
  readonly head: string;
  readonly number: PullRequestNumber;
  readonly stack: Option.Option<StackLink>;
  readonly state: PullRequestState;
  readonly title: string;
  readonly url: string;
}

/**
 * A stack registered on GitHub, with its pull requests that haven't merged bottom to top. One closed
 * without merging stays in the stack, so it is among them.
 */
export interface RemoteStack {
  readonly number: StackNumber;
  readonly unmerged: readonly PullRequestNumber[];
}
