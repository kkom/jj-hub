import { Console, Data, Effect } from "effect";

import { GitHub, type GitHubFailed } from "../../../clients/github/client";
import { Jj, type JjFailed } from "../../../clients/jj";
import { PrDescriptions } from "../../../clients/pr-descriptions";
import {
  anyOf,
  bookmarkRevset,
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
import { type BookmarkBeforeFetch, combine, pushedOf } from "./combine";

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

/** Whether the bookmark's change is none of the merged ones. */
export const notMerged =
  (merged: readonly MergedChange[]) =>
  (name: string): boolean =>
    merged.every(({ bookmark }) => bookmark !== name);

/** The head commit of each merged pull request from each pushed bookmark's branch. */
export const mergedHeadsOf = (
  bookmarks: readonly BookmarkBeforeFetch[],
): Effect.Effect<Readonly<Record<string, readonly string[]>>, GitHubFailed, GitHub> =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const pushed = pushedOf(bookmarks);
    const heads = yield* Effect.forEach(
      pushed,
      ({ name }) =>
        github
          .pullRequestsFrom(name)
          .pipe(
            Effect.map((pullRequests) =>
              pullRequests.filter(({ state }) => state === "merged").map(({ head }) => head),
            ),
          ),
      { concurrency: "unbounded" },
    );
    return Object.fromEntries(pushed.map(({ name }, index) => [name, heads[index] ?? []]));
  });

/** `mergedOnGitHub`, from merged heads already read. */
export const mergedIn = (
  bookmarks: readonly BookmarkBeforeFetch[],
  heads: Readonly<Record<string, readonly string[]>>,
): Effect.Effect<readonly MergedChange[], JjFailed, Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    const merged = yield* Effect.forEach(bookmarks, ({ change, local, name, remote }) =>
      Effect.gen(function* () {
        const merges = heads[name] ?? [];
        const rebasedOnly =
          remote !== undefined &&
          merges.includes(remote) &&
          (yield* jj.read(["interdiff", "--from", remote, "--to", local, "--summary"])).trim() ===
            "";
        return merges.includes(local) || rebasedOnly ? [{ bookmark: name, changeId: change }] : [];
      }),
    );
    return merged.flat();
  });

/**
 * The changes whose pull requests GitHub reports as merged. A change counts where GitHub merged
 * it as it is, or merged the commit pushed for it, which it differs from only by a rebase, as
 * after a sync. So a change edited since keeps its edits, and a pull request from an earlier
 * branch of the same name doesn't count.
 */
export const mergedOnGitHub = (
  bookmarks: readonly BookmarkBeforeFetch[],
): Effect.Effect<readonly MergedChange[], GitHubFailed | JjFailed, GitHub | Jj> =>
  Effect.flatMap(mergedHeadsOf(bookmarks), (heads) => mergedIn(bookmarks, heads));

/**
 * Forgets the bookmarks and their branches on GitHub, in one jj operation. A fetch has already
 * deleted the bookmark of a branch deleted on GitHub, where it was unchanged locally, and jj warns
 * about a name it can't find, so only the names still listed are passed.
 */
const forget = (names: readonly string[]) =>
  Effect.gen(function* () {
    const listed = yield* bookmarkTargets;
    const present = names.filter((name) => listed.has(name));
    if (present.length > 0) {
      const jj = yield* Jj;
      yield* jj.run([
        "bookmark",
        "forget",
        "--include-remotes",
        ...present.map((name) => `exact:${name}`),
      ]);
    }
  });

interface Reconciliation {
  /** The bookmarks to combine with their branches, as they were before the fetch. */
  readonly before: readonly BookmarkBeforeFetch[];
  readonly merged: readonly MergedChange[];
  /**
   * Every stack, or one stack: the trunk to fetch for it, its bookmarks, and the ids of its
   * changes without one. Those find the stack after the sync, since a bookmark follows a change
   * replaced with GitHub's, and a change keeps its id.
   */
  readonly scope:
    | "every stack"
    | {
        readonly bookmarks: readonly string[];
        readonly trunk: string;
        readonly unnamed: readonly string[];
      };
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
 *
 * Last, it deletes the recorded pull request descriptions of bookmarks that are gone.
 */
export const reconcile = ({
  before,
  merged,
  scope,
}: Reconciliation): Effect.Effect<void, JjFailed | NotCombined, Jj | PrDescriptions> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    const branches =
      scope === "every stack"
        ? []
        : [scope.trunk, ...pushedOf(before).map(({ name }) => name)].flatMap((branch) => [
            "--branch",
            `exact:${branch}`,
          ]);
    yield* jj.run(["git", "fetch", ...branches]);
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
    for (const bookmark of before.filter(({ name }) => notMerged(merged)(name))) {
      if (!(yield* combine(bookmark, fetched.get(bookmark.name)?.origin))) {
        notCombined.push(bookmark.name);
      }
    }
    const roots =
      scope === "every stack"
        ? BEHIND_ROOTS
        : `(${BEHIND_ROOTS}) & ::(${anyOf([
            ...scope.bookmarks.map((name) => bookmarkRevset(name)),
            ...scope.unnamed.map((change) => `change_id(${change})`),
          ])})`;
    for (const root of yield* commitsAt(roots)) {
      yield* rebaseStack(root, required);
    }
    const onStacks = new Set(
      scope === "every stack" ? before.map(({ name }) => name) : scope.bookmarks,
    );
    yield* forget((yield* bookmarksAt("::trunk()")).filter((name) => onStacks.has(name)));
    const records = yield* PrDescriptions;
    // `bookmarksAt` lists conflicted bookmarks too, which `bookmarkTargets` gives no local target.
    yield* records.prune(Effect.provideService(bookmarksAt("all()"), Jj, jj));
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
