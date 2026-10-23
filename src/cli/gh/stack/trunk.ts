import { Data, Effect } from "effect";

import { GitHub, type GitHubFailed } from "../../../clients/github/client";
import type { Jj, JjFailed } from "../../../clients/jj";
import { commitsAt } from "./changes";

export class TrunkMismatch extends Data.TaggedError("TrunkMismatch")<{
  readonly message: string;
}> {}

/** The default branch as `origin` has it, quoted so that any branch name parses. */
export const trunkRevset = (branch: string): string => `${JSON.stringify(branch)}@origin`;

/**
 * Fails unless `trunk()` is the commit of GitHub's default branch. jj's own `trunk()` guesses
 * from the branch names it knows, so a repository whose default branch it doesn't guess would
 * otherwise have its stacks rebased onto one branch and their pull requests based on another.
 */
export const checkTrunk = (branch: string): Effect.Effect<void, JjFailed | TrunkMismatch, Jj> =>
  Effect.gen(function* () {
    if ((yield* commitsAt(`trunk() & present(${trunkRevset(branch)})`)).length === 0) {
      yield* new TrunkMismatch({
        message: `trunk() isn't ${branch}@origin, GitHub's default branch; run \`jj-octo init\``,
      });
    }
  });

/** GitHub's default branch, read once and checked to be `trunk()`. */
export const checkedTrunk: Effect.Effect<
  string,
  GitHubFailed | JjFailed | TrunkMismatch,
  GitHub | Jj
> = Effect.gen(function* () {
  const branch = yield* (yield* GitHub).defaultBranch;
  yield* checkTrunk(branch);
  return branch;
});
