import { Console, Effect } from "effect";

import { Jj, type JjFailed } from "../../../clients/jj";
import { bookmarkRevset, bookmarkTargets, commitsAt, lines, readLog } from "./changes";

// Combines a local change with its branch on GitHub after a fetch, for `sync` and `submit`.

/** Where a bookmark on a stack pointed before the fetch. */
export interface BookmarkBeforeFetch {
  /** The change's id, which stays the same when the change is rewritten. */
  readonly change: string;
  readonly local: string;
  readonly name: string;
  /** The commit of its branch, for a bookmark that was pushed. */
  readonly remote: string | undefined;
}

// Top first, because folding GitHub's commits into a change rewrites everything above it. Done
// bottom first, a commit GitHub added higher up would be rewritten too, and left behind as a
// change of its own.
export const bookmarksBeforeFetch = (
  revset: string,
): Effect.Effect<readonly BookmarkBeforeFetch[], JjFailed, Jj> =>
  Effect.gen(function* () {
    const targets = [...(yield* bookmarkTargets)];
    const bottomFirst = lines(
      yield* readLog(
        `(${revset}) & bookmarks()`,
        String.raw`commit_id ++ "\t" ++ change_id ++ "\n"`,
      ),
    );
    return bottomFirst.toReversed().flatMap((line): readonly BookmarkBeforeFetch[] => {
      const [commit = "", change = ""] = line.split("\t");
      return targets
        .filter(([, { local }]) => local === commit)
        .map(([name, { origin }]) => ({ change, local: commit, name, remote: origin }));
    });
  });

/**
 * The local commit of a change after a fetch and whatever was rewritten since. The fetch can
 * bring back the commit that was pushed, and GitHub's copies can carry the same change id, so
 * those two are left out. With nothing else, the change is still the commit that was pushed. With
 * nothing at all, the fetch abandoned it, which it does where no branch on GitHub contains it.
 */
const localCommit = (change: string, remote: string, fetched: string) =>
  Effect.gen(function* () {
    const commits = yield* commitsAt(`change_id(${change})`);
    const local = commits.filter((commit) => commit !== remote && commit !== fetched);
    if (local.length === 0) {
      return commits.includes(remote) ? [remote] : [];
    }
    return local;
  });

/**
 * Makes the local change and its branch on GitHub one change again after a fetch, and returns
 * whether it could. The local change stays the one change of its pull request, and nothing GitHub
 * has is dropped.
 *
 * The fetch moves the bookmark to GitHub's commit where the local change was untouched, and
 * leaves it conflicted where both sides changed.
 */
export const combine = (
  { change, local: localBefore, name, remote }: BookmarkBeforeFetch,
  fetched: string | undefined,
): Effect.Effect<boolean, JjFailed, Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    // Never pushed, unchanged on GitHub, or deleted there, which a merged branch is.
    if (remote === undefined || fetched === undefined || fetched === remote) {
      return true;
    }
    const [local, ...others] = yield* localCommit(change, remote, fetched);
    if (local === undefined) {
      return true;
    }
    if (others.length > 0) {
      return false;
    }
    const keepLocal = jj.run(["bookmark", "set", name, "-r", local, "--allow-backwards"]);
    // GitHub's commits that the local change now replaces. Left alone they stay in the log as a
    // second copy of the change.
    const dropCopies = jj.run([
      "abandon",
      `((::${fetched} | ::${remote}) & mutable()) ~ ::${bookmarkRevset(name)}`,
    ]);

    if ((yield* commitsAt(`${remote} & ::${fetched}`)).length > 0) {
      yield* keepLocal;
      yield* jj.run([
        "squash",
        "--from",
        `(${remote}..${fetched}) & mutable()`,
        "--into",
        local,
        "--use-destination-message",
      ]);
      yield* dropCopies;
      yield* Console.error(`folded what GitHub added to ${name} into its change`);
      return true;
    }

    // From here GitHub rewrote the branch: its commit doesn't contain the one pushed.
    if (localBefore === remote) {
      yield* jj.run(["rebase", "--source", `children(${local})`, "--destination", fetched]);
      yield* jj.run(["abandon", local]);
      yield* Console.error(`took GitHub's rewritten ${name}, which wasn't changed locally`);
      return true;
    }
    const added = yield* jj.read(["interdiff", "--from", remote, "--to", fetched, "--summary"]);
    if (added.trim() === "") {
      yield* keepLocal;
      yield* dropCopies;
      yield* Console.error(`kept the local ${name}, which GitHub had only rebased`);
      return true;
    }
    return false;
  });
