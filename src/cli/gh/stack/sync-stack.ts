import { Console, Data, Effect } from "effect";

import { Git, type GitFailed } from "../../../clients/git";
import type { GitHub, GitHubFailed } from "../../../clients/github/client";
import { Jj, type JjFailed } from "../../../clients/jj";
import { bookmarksAt, changeIdsAt, downstackRevset, lines, stackRevset } from "./changes";
import { type BookmarkBeforeFetch, bookmarksBeforeFetch, pushedOf } from "./combine";
import { mergedHeadsOf, mergedIn, type NotCombined, notMerged, reconcile } from "./reconcile";

// Syncs one stack, for `submit`, where GitHub merged or changed any of it.

export class BranchesDeleted extends Data.TaggedError("BranchesDeleted")<{
  readonly message: string;
}> {}

/** Why a deleted branch's change doesn't count as merged, from its merged pull requests' heads. */
const whyDeleted = (heads: readonly string[], { remote }: BookmarkBeforeFetch): string => {
  if (remote !== undefined && heads.includes(remote)) {
    return "its pushed commit merged, and the change was edited since";
  }
  return heads.length > 0
    ? "a pull request from it merged, but not the commit pushed for this change"
    : "no pull request from it merged";
};

/**
 * The pushed bookmarks whose branch on GitHub isn't the commit jj last fetched, as after GitHub
 * rebases the rest of a stack whose bottom merged. Read from the remote itself, without a fetch.
 * Also the ones whose branch GitHub deleted.
 */
const changedOnGitHub = (bookmarks: readonly BookmarkBeforeFetch[]) =>
  Effect.gen(function* () {
    const pushed = pushedOf(bookmarks);
    // With no refs named, ls-remote lists every branch.
    if (pushed.length === 0) {
      return { changed: [], deleted: [] };
    }
    const git = yield* Git;
    // Jj's own git repository, which a jj workspace without a `.git` of its own also has.
    const gitDirectory = (yield* (yield* Jj).read(["git", "root"])).trim();
    const output = yield* git.read([
      "--git-dir",
      gitDirectory,
      "ls-remote",
      "origin",
      ...pushed.map(({ name }) => `refs/heads/${name}`),
    ]);
    const onGitHub = new Map(
      lines(output).map((line) => {
        const [commit = "", ref = ""] = line.split("\t");
        return [ref.replace(/^refs\/heads\//u, ""), commit];
      }),
    );
    return {
      changed: pushed
        .filter(({ name, remote }) => onGitHub.has(name) && onGitHub.get(name) !== remote)
        .map(({ name }) => name),
      deleted: pushed.filter(({ name }) => !onGitHub.has(name)),
    };
  });

/**
 * Syncs the revision's stack alone, as `sync` does every stack, where any pull request of the
 * revision or the changes below it merged, or any of their branches changed on GitHub. Fetches
 * only those branches and the trunk, so other stacks stay as they are. The changes above are
 * rebased with the stack, and their branches are left for their own submit. Returns whether it
 * synced.
 */
export const syncStack = (
  revision: string,
  trunk: string,
): Effect.Effect<
  boolean,
  BranchesDeleted | GitFailed | GitHubFailed | JjFailed | NotCombined,
  Git | GitHub | Jj
> =>
  Effect.gen(function* () {
    // The changes above the revision aren't submitted, so they're synced only by following these.
    const downstack = downstackRevset(revision);
    const before = yield* bookmarksBeforeFetch(downstack);
    const [heads, onGitHub] = yield* Effect.all([mergedHeadsOf(before), changedOnGitHub(before)], {
      concurrency: "unbounded",
    });
    const merged = yield* mergedIn(before, heads);
    const changed = onGitHub.changed.filter(notMerged(merged));
    // A fetch would delete the local bookmark, and the commit with it where nothing else keeps it.
    // That is right only for work that merged, which a merged pull request with another head
    // doesn't prove: GitHub may have added commits before merging, or the name may be reused.
    const deleted = onGitHub.deleted.filter(({ name }) => notMerged(merged)(name));
    if (deleted.length > 0) {
      return yield* new BranchesDeleted({
        message: [
          "these branches were deleted on GitHub, so nothing was changed:",
          ...deleted.map(
            (bookmark) => `${bookmark.name}: ${whyDeleted(heads[bookmark.name] ?? [], bookmark)}`,
          ),
          "to push a change again, run `jj bookmark forget --include-remotes <name>`, then `jj bookmark create <name> -r <change>`; to drop one, run `jj abandon <change>`",
        ].join("\n"),
      });
    }
    const found = [
      ...merged.map(({ bookmark }) => `${bookmark} merged`),
      ...changed.map((name) => `${name} changed`),
    ];
    if (found.length === 0) {
      return false;
    }
    yield* Console.error(`on GitHub, ${found.join(", ")}; syncing the stack first`);
    // The whole stack is rebased, so the changes above the revision keep their place on it.
    const whole = stackRevset(revision);
    yield* reconcile({
      before,
      merged,
      scope: {
        bookmarks: yield* bookmarksAt(whole),
        trunk,
        // With the working copy on top, which follows the stack even where all of it merged.
        unnamed: yield* changeIdsAt(`((${whole}) | (@ & children(${whole}))) ~ bookmarks()`),
      },
    });
    return true;
  });
