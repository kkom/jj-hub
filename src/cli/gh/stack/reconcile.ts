import { Console, Data, Effect } from "effect";

import { GitHub, type GitHubFailed } from "../../../clients/github/client";
import { Jj, type JjFailed } from "../../../clients/jj";
import {
  anyOf,
  bookmarksAt,
  bookmarkTargets,
  changeIdsAt,
  changesIn,
  commitsAt,
  lines,
  STACK_ROOTS,
  type StackChange,
  stackRevset,
} from "./changes";
import { type BookmarkBeforeFetch, combine } from "./combine";

// A stack already on the trunk has nothing to rebase.
const BEHIND_ROOTS = `(${STACK_ROOTS}) ~ children(trunk())`;

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
    const rebased = anyOf(changes.map((change) => `change_id(${change})`));
    const untouched = anyOf(conflictedCommits);
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
export const mergedOnGitHub = (
  bookmarks: readonly BookmarkBeforeFetch[],
): Effect.Effect<readonly MergedChange[], GitHubFailed, GitHub> =>
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

/** Forgets the bookmarks and their branches on GitHub, in one jj operation. */
const forget = (names: readonly string[]) =>
  Effect.gen(function* () {
    if (names.length > 0) {
      const jj = yield* Jj;
      yield* jj.run([
        "bookmark",
        "forget",
        "--include-remotes",
        ...names.map((name) => `exact:${name}`),
      ]);
    }
  });

interface Reconciliation {
  /** The bookmarks to combine with their branches, as they were before the fetch. */
  readonly before: readonly BookmarkBeforeFetch[];
  readonly merged: readonly MergedChange[];
}

/**
 * Fetches, abandons the merged changes, combines each bookmark with its branch on GitHub, and
 * rebases the stacks onto the trunk.
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
export const reconcile = ({
  before,
  merged,
}: Reconciliation): Effect.Effect<void, JjFailed | NotCombined, Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    yield* jj.run(["git", "fetch"]);
    // After the fetch, so it can't bring a branch GitHub hasn't deleted yet back as a bookmark.
    yield* forget(merged.map(({ bookmark }) => bookmark));
    const mergedRevset = `(${anyOf(merged.map(({ changeId }) => `change_id(${changeId})`))}) & mutable()`;
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
    yield* forget(
      (yield* bookmarksAt("::trunk()")).filter((name) =>
        before.some((bookmark) => bookmark.name === name),
      ),
    );
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
