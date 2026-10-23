import { Effect } from "effect";
import { Command } from "effect/cli";

import type { GitHub, GitHubFailed } from "../../clients/github/client";
import { GitHubFromOrigin } from "../../clients/github/origin";
import type { Jj, JjFailed } from "../../clients/jj";
import { asUserError, withHelp } from "../command";
import { bookmarksBeforeFetch } from "./stack/combine";
import { type MergedChange, mergedOnGitHub, type NotCombined, reconcile } from "./stack/reconcile";
import { checkedTrunk } from "./stack/trunk";

/**
 * Rebases every stack that doesn't conflict onto the fetched trunk, and pushes nothing. Each
 * bookmark is combined with its branch on GitHub first, and each merged change abandoned.
 */
export const sync = (
  // Changes known to have merged, which GitHub isn't asked about.
  known: readonly MergedChange[] = [],
): Effect.Effect<void, GitHubFailed | JjFailed | NotCombined, GitHub | Jj> =>
  Effect.gen(function* () {
    const before = yield* bookmarksBeforeFetch("mutable()");
    const merged = [
      ...known,
      ...(yield* mergedOnGitHub(
        before.filter(({ name }) => known.every(({ bookmark }) => bookmark !== name)),
      )),
    ];
    yield* reconcile({ before, merged });
  });

export const syncCommand = Command.make("sync", {}, () =>
  asUserError(
    Effect.gen(function* () {
      yield* checkedTrunk;
      yield* sync();
    }).pipe(Effect.provide(GitHubFromOrigin)),
  ),
).pipe(
  withHelp(
    "Fetch, and rebase every change onto the trunk",
    "Fetches, then rebases every change that isn't merged yet onto the trunk, keeping each on the changes below it. A change whose pull request GitHub merged is abandoned and its bookmark forgotten, unless it was edited after the merge.",
    "A stack that would conflict with the trunk is left where it was, and named. Rebase it yourself with `jj rebase` when you want to resolve it. The rest of a stack whose changes merged is rebased even where it conflicts, and the conflict is recorded in the change.",
    "Commits added to a branch on GitHub are squashed into the branch's local change, whether or not that change was also edited locally. Where GitHub only rebased a branch, the local change is kept.",
    "Fails before fetching if `trunk()` isn't GitHub's default branch, which `jj-octo init` sets.",
    "Pushes nothing. Run `jj gh submit` to update the pull requests of a change and the ones below it.",
  ),
);
