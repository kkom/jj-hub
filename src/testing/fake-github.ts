import { Effect, Layer, Option } from "effect";

import { GitHub } from "../clients/github/client";
import {
  type PullRequest,
  type PullRequestNumber,
  PullRequestNumberSchema,
  type RemoteStack,
  StackNumberSchema,
} from "../clients/github/types";

interface FakeGitHubOptions {
  /** The head commit of each merged pull request from the branch. None by default. */
  readonly mergedHeads?: (branch: string) => readonly string[];
  /** What GitHub does to the repository when it merges, which the fake has no repository to do. */
  readonly onMerge?: (pullRequest: PullRequestNumber) => void;
}

// A GitHub with the given open pull requests and stack, recording every call that changes something.
export const fakeGitHub = (
  open: Readonly<Record<string, PullRequest>>,
  stack: Option.Option<RemoteStack>,
  { mergedHeads = () => [], onMerge }: FakeGitHubOptions = {},
): { readonly calls: readonly string[]; readonly layer: Layer.Layer<GitHub> } => {
  const calls: string[] = [];
  let registered = stack;
  const record = (call: string) =>
    Effect.sync(() => {
      calls.push(call);
    });
  const layer = Layer.succeed(GitHub, {
    addToStack: (number, pullRequests) => record(`add ${pullRequests.join(",")} to #${number}`),
    createPullRequest: ({ base, draft, head }) =>
      record(`open ${head} on ${base}${draft ? " as a draft" : ""}`).pipe(
        Effect.as(PullRequestNumberSchema.make(99)),
      ),
    createStack: (pullRequests) =>
      record(`create stack ${pullRequests.join(",")}`).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            registered = Option.some({ number: StackNumberSchema.make(8), open: pullRequests });
          }),
        ),
        Effect.as(StackNumberSchema.make(8)),
      ),
    defaultBranch: Effect.succeed("main"),
    mergePullRequest: (number) =>
      record(`merge #${number}`).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            onMerge?.(number);
          }),
        ),
      ),
    mergeStack: (number) =>
      record(`merge the stack up to #${number}`).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            onMerge?.(number);
          }),
        ),
        Effect.as("merged"),
      ),
    mergedHeads: (branch) => Effect.sync(() => mergedHeads(branch)),
    openPullRequest: (branch) => Effect.succeed(Option.fromNullishOr(open[branch])),
    setBase: (number, base) => record(`base #${number} → ${base}`),
    setDescription: (number, { title }) => record(`describe #${number} as ${title}`),
    stackOf: () => Effect.sync(() => registered),
    unstack: (number) =>
      record(`unstack #${number}`).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            registered = Option.none();
          }),
        ),
      ),
  });
  return { calls, layer };
};

export const pullRequests = (...numbers: readonly number[]): readonly PullRequestNumber[] =>
  numbers.map((number) => PullRequestNumberSchema.make(number));

/** Stack #7, with the given open pull requests. */
export const stackOf = (...open: readonly number[]): Option.Option<RemoteStack> =>
  Option.some({ number: StackNumberSchema.make(7), open: pullRequests(...open) });

/** An open draft pull request with a title and no body. */
export const openPullRequest = (base: string, number: number, title: string): PullRequest => ({
  base,
  body: "",
  draft: true,
  number: PullRequestNumberSchema.make(number),
  title,
});
