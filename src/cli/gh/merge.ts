import { Console, Data, Effect, Option } from "effect";
import { Command } from "effect/cli";

import type { Git } from "../../clients/git";
import { GitHub } from "../../clients/github/client";
import { GitHubFromOrigin } from "../../clients/github/origin";
import type { PullRequest, PullRequestNumber } from "../../clients/github/types";
import type { Jj } from "../../clients/jj";
import { asUserError, revisionFlag, withHelp } from "../command";
import {
  bookmarkRevset,
  bookmarksAt,
  bookmarkTargets,
  commitsAt,
  downstackChanges,
  pushedState,
  upstackRevset,
} from "./stack/changes";
import { type PublishFailed, republish } from "./stack/publish";
import { checkTrunk } from "./stack/trunk";
import { type NotCombined, sync } from "./sync";

export class NotMergeable extends Data.TaggedError("NotMergeable")<{
  readonly message: string;
}> {}

const numbered = (pullRequests: readonly PullRequestNumber[]): string =>
  pullRequests.map((number) => `#${number}`).join(", ");

const openPullRequestOf = (bookmark: string) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const opened = yield* github.openPullRequest(bookmark);
    if (Option.isNone(opened)) {
      return yield* new NotMergeable({
        message: `no open pull request for ${bookmark}; run \`jj gh submit\` first`,
      });
    }
    return opened.value;
  });

/** Merges the pull request, and returns whether it has merged or is only queued to. */
const mergeOnGitHub = ({ base, number }: PullRequest, trunk: string) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const stack = yield* github.stackOf(number);
    if (Option.isSome(stack)) {
      const { open } = stack.value;
      yield* Console.error(`merging ${numbered(open.slice(0, open.indexOf(number) + 1))}`);
      return yield* github.mergeStack(number);
    }
    // Outside a GitHub stack a merge goes into the pull request's base, and takes nothing below
    // it along.
    if (base !== trunk) {
      return yield* new NotMergeable({
        message: `#${number} isn't in a GitHub stack, and its base is ${base}, so merging it wouldn't reach the trunk; run \`jj gh submit\` to register the stack, or merge the changes below it first`,
      });
    }
    yield* Console.error(`merging ${numbered([number])}`);
    yield* github.mergePullRequest(number);
    return "merged" as const;
  });

/**
 * Merges the pull requests of the revision's change and the ones below it in its stack. One in a
 * GitHub stack is merged through the stack API, together with everything below it, or nothing at
 * all. One outside a stack is merged normally. Then syncs, and republishes what is left of the
 * stack.
 */
export const merge = (
  revision: string,
): Effect.Effect<void, NotCombined | NotMergeable | PublishFailed, Git | GitHub | Jj> =>
  Effect.gen(function* () {
    const trunk = yield* (yield* GitHub).defaultBranch;
    yield* checkTrunk(trunk);
    const changes = yield* downstackChanges(revision);
    const top = changes.at(-1)?.bookmark ?? "";

    // GitHub merges what was pushed, so an edit made since would be left behind on a change
    // whose branch is gone.
    const targets = yield* bookmarkTargets;
    const unpushed = changes.filter(
      (change) => pushedState(targets.get(change.bookmark), change) !== "pushed",
    );
    if (unpushed.length > 0) {
      yield* new NotMergeable({
        message: `these changes aren't pushed: ${unpushed.map(({ bookmark }) => bookmark).join(", ")}; run \`jj gh submit\` first`,
      });
    }
    const pullRequest = yield* openPullRequestOf(top);
    const above = yield* bookmarksAt(upstackRevset(bookmarkRevset(top)));

    if ((yield* mergeOnGitHub(pullRequest, trunk)) === "enqueued") {
      yield* Console.error("queued to merge; run `jj gh sync` once it has");
    } else {
      yield* Console.error(`merged up to #${pullRequest.number}`);
      // GitHub merged exactly what was pushed, as checked above.
      yield* sync(changes);
      // Any bookmark left above the merged change names the rest of its stack.
      for (const bookmark of above) {
        if ((yield* commitsAt(bookmarkRevset(bookmark))).length > 0) {
          yield* republish(bookmarkRevset(bookmark));
          break;
        }
      }
    }
  });

export const mergeCommand = Command.make(
  "merge",
  { revision: revisionFlag("The top change to merge") },
  ({ revision }) => asUserError(merge(revision).pipe(Effect.provide(GitHubFromOrigin))),
).pipe(
  withHelp(
    "Merge the pull requests of a change and the ones below it",
    "Squash-merges them, and prints which before it does. An empty working copy means the change below it. Fails before merging if any of the changes has edits that aren't pushed.",
    "A pull request in a GitHub stack is merged together with the pull requests below it. Either all of them merge or none does. A pull request outside a stack is merged alone, and only if its base is the trunk.",
    "Then syncs, as `jj gh sync` does: it abandons the merged changes, forgets their bookmarks, and rebases the rest of the stack onto the trunk even where it conflicts, recording the conflict in the change. Then it pushes what is left of the change's stack again, up to the highest branch already on GitHub.",
    "If GitHub queues the merge instead, nothing is synced. Run `jj gh sync` once it has merged.",
  ),
);
