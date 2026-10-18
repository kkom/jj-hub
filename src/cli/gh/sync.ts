import { Console, Data, Effect } from "effect";
import { Command } from "effect/cli";

import { GitHub, type GitHubFailed } from "../../clients/github/client";
import { GitHubFromOrigin } from "../../clients/github/origin";
import { Jj, type JjFailed } from "../../clients/jj";
import { asUserError, withHelp } from "../command";
import {
  bookmarkRevset,
  bookmarksAt,
  bookmarkTargets,
  changeIdsAt,
  changesIn,
  commitsAt,
  lines,
  readLog,
  STACK_ROOTS,
  type StackChange,
  stackRevset,
} from "./stack/changes";
import { checkTrunk } from "./stack/trunk";

// A stack already on the trunk has nothing to rebase.
const BEHIND_ROOTS = `(${STACK_ROOTS}) ~ children(trunk())`;

/** Where a bookmark on a stack pointed before the fetch. */
interface BookmarkBeforeFetch {
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
const bookmarksBeforeFetch = Effect.gen(function* () {
  const targets = [...(yield* bookmarkTargets)];
  const bottomFirst = lines(
    yield* readLog("mutable() & bookmarks()", String.raw`commit_id ++ "\t" ++ change_id ++ "\n"`),
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
const combine = (
  { change, local: localBefore, name, remote }: BookmarkBeforeFetch,
  fetched: string | undefined,
) =>
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

export class NotCombined extends Data.TaggedError("NotCombined")<{ readonly message: string }> {}

/**
 * Rebases one stack onto the trunk, unless that gives any of its changes a conflict it didn't
 * have. Then the stack goes back where it was, so work nobody is looking at isn't left conflicted.
 * A stack holding one of the `required` changes is rebased whatever happens, and keeps the conflict.
 */
const rebaseStack = (root: string, required: readonly string[]) =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    const stack = stackRevset(root);
    const [name = root] = yield* changesIn(root);
    const changes = yield* changeIdsAt(stack);
    const conflicted = yield* changeIdsAt(`conflicts() & (${stack})`);
    const conflictedCommits = yield* commitsAt("conflicts() & mutable()");
    const [operation = ""] = lines(
      yield* jj.read([
        "operation",
        "log",
        "--no-graph",
        "--limit",
        "1",
        "-T",
        String.raw`id ++ "\n"`,
      ]),
    );
    yield* jj.run(["rebase", "--source", root, "--destination", "trunk()", "--skip-emptied"]);
    // A merged change is abandoned by the rebase, so its id may be gone. A change that wasn't
    // combined with a push from another checkout has two commits with one id. `change_id()`
    // selects none or both, where the bare id fails. The other commit is in another stack, so a
    // conflict it already had isn't one this rebase caused.
    const rebased = ["none()", ...changes.map((change) => `change_id(${change})`)].join(" | ");
    const untouched = ["none()", ...conflictedCommits].join(" | ");
    const conflictedNow = yield* changeIdsAt(`(conflicts() & (${rebased})) ~ (${untouched})`);
    const mayRestore = !changes.some((change) => required.includes(change));
    if (mayRestore && conflictedNow.some((change) => !conflicted.includes(change))) {
      yield* jj.run(["operation", "restore", operation]);
      yield* Console.error(
        `left "${name}" and the changes on it where they were: they conflict with the trunk`,
      );
    }
  });

/** A change whose pull request merged, with the bookmark that names its branch. */
export type MergedChange = Pick<StackChange, "bookmark" | "changeId">;

/**
 * The changes whose pull requests GitHub reports as merged. Only a change that is still the
 * commit GitHub merged counts, so a change edited since keeps its edits, and a pull request from
 * an earlier branch of the same name doesn't count.
 */
const mergedOnGitHub = (bookmarks: readonly BookmarkBeforeFetch[]) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const merged = yield* Effect.forEach(
      bookmarks.filter(({ remote }) => remote !== undefined),
      ({ change, local, name }) =>
        github
          .mergedHeads(name)
          .pipe(
            Effect.map((heads): readonly MergedChange[] =>
              heads.includes(local) ? [{ bookmark: name, changeId: change }] : [],
            ),
          ),
      { concurrency: "unbounded" },
    );
    return merged.flat();
  });

/**
 * Rebases every stack that doesn't conflict onto the fetched trunk, and pushes nothing.
 *
 * A squash merge adds the merged work to the trunk as a new commit, so the original change still
 * sits under the rest of its stack. Rebased onto the trunk, it can conflict with what the trunk
 * now has, rather than come out empty: where a change merged above it edited the same lines, or
 * the trunk moved. So every change whose pull request merged is abandoned, and its bookmark
 * forgotten. The rest of its stack is rebased even where that conflicts, since what it was based
 * on is gone.
 *
 * A change that reaches the trunk some other way is empty after the rebase, and `--skip-emptied`
 * abandons it. Its bookmark then stays behind on the trunk, so every bookmark that was on a stack
 * and is now on the trunk is forgotten too, remote side included.
 */
export const sync = (
  // Changes known to have merged, which GitHub isn't asked about.
  known: readonly MergedChange[] = [],
): Effect.Effect<void, GitHubFailed | JjFailed | NotCombined, GitHub | Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    const before = yield* bookmarksBeforeFetch;
    const merged = [
      ...known,
      ...(yield* mergedOnGitHub(
        before.filter(({ name }) => known.every(({ bookmark }) => bookmark !== name)),
      )),
    ];
    yield* jj.run(["git", "fetch"]);
    // After the fetch, so it can't bring a branch GitHub hasn't deleted yet back as a bookmark.
    for (const { bookmark } of merged) {
      yield* jj.run(["bookmark", "forget", "--include-remotes", `exact:${bookmark}`]);
    }
    const mergedRevset = `(${["none()", ...merged.map(({ changeId }) => `change_id(${changeId})`)].join(" | ")}) & mutable()`;
    const required = yield* changeIdsAt(`(${mergedRevset}):: ~ (${mergedRevset})`);
    if (merged.length > 0) {
      yield* jj.run(["abandon", mergedRevset]);
      yield* Console.error(
        `abandoned the changes whose pull requests merged: ${merged.map(({ bookmark }) => bookmark).join(", ")}`,
      );
    }
    const fetched = yield* bookmarkTargets;
    const notCombined: string[] = [];
    for (const bookmark of before.filter(({ name }) =>
      merged.every((change) => change.bookmark !== name),
    )) {
      if (!(yield* combine(bookmark, fetched.get(bookmark.name)?.origin))) {
        notCombined.push(bookmark.name);
      }
    }
    for (const root of yield* commitsAt(BEHIND_ROOTS)) {
      yield* rebaseStack(root, required);
    }
    const onTrunk = (yield* bookmarksAt("::trunk()")).filter((name) =>
      before.some((bookmark) => bookmark.name === name),
    );
    for (const name of onTrunk) {
      yield* jj.run(["bookmark", "forget", "--include-remotes", `exact:${name}`]);
    }
    if (notCombined.length > 0) {
      yield* new NotCombined({
        message: [
          "these bookmarks changed locally and were rewritten on GitHub with different content, so they weren't combined:",
          ...notCombined,
          "`jj bookmark list <name>` shows both sides, and `jj bookmark set <name> -r <revision>` keeps one",
        ].join("\n"),
      });
    }
  });

export const syncCommand = Command.make("sync", {}, () =>
  asUserError(
    Effect.gen(function* () {
      yield* checkTrunk(yield* (yield* GitHub).defaultBranch);
      yield* sync();
    }).pipe(Effect.provide(GitHubFromOrigin)),
  ),
).pipe(
  withHelp(
    "Fetch, and rebase every change onto the trunk",
    "Fetches, then rebases every change that isn't merged yet onto the trunk, keeping each on the changes below it. A change whose pull request GitHub merged is abandoned and its bookmark forgotten, unless it was edited after the merge.",
    "A stack that would conflict with the trunk is left where it was, and named. Rebase it yourself with `jj rebase` when you want to resolve it. The rest of a stack whose changes merged is rebased even where it conflicts, and the conflict is recorded in the change.",
    "Commits added to a branch on GitHub are squashed into the branch's local change, whether or not that change was also edited locally. Where GitHub only rebased a branch, the local change is kept.",
    "Fails before fetching if `trunk()` isn't GitHub's default branch, which `jj gh init` sets.",
    "Pushes nothing. Run `jj gh submit` to update the pull requests of a change and the ones below it.",
  ),
);
