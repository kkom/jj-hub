import { Data, Effect } from "effect";

import { Jj, type JjFailed } from "../../../clients/jj";

export class NotAStack extends Data.TaggedError("NotAStack")<{ readonly message: string }> {}

// The bottom change of every stack. A mutable change on anything but the trunk's history, such as
// one on a release branch, is in no stack.
export const STACK_ROOTS = "roots(mutable()) & children(::trunk())";

// The scratch change `jj new` and `jj commit` leave on top, or the one another workspace starts from.
const SCRATCH = '(working_copies() & empty() & description(exact:""))';

// Every change connected to the revision through mutable changes. Separate stacks meet only at
// the trunk, which is immutable, so this never reaches into another one.
export const stackRevset = (revision: string): string =>
  `(reachable(${revision}, mutable()) & (${STACK_ROOTS})::) ~ ${SCRATCH}`;

// For an empty working copy, which the stack leaves out, this starts at the change below it.
export const downstackRevset = (revision: string): string =>
  `::(${revision}) & (${stackRevset(revision)})`;

/** The changes of the revision's stack that are above it. */
export const upstackRevset = (revision: string): string =>
  `(${revision})+:: & (${stackRevset(revision)})`;

/** The commits of any of the revsets. With none, no commits, where an empty union fails. */
export const anyOf = (revsets: readonly string[]): string => ["none()", ...revsets].join(" | ");

/** The change a bookmark is on. */
export const bookmarkRevset = (bookmark: string): string => `bookmarks(exact:"${bookmark}")`;

export const lines = (output: string): readonly string[] =>
  output.split("\n").filter((line) => line !== "");

/** A description that a template printed with `escape_json()`. */
export const parseDescription = (json: string): string => {
  const parsed: unknown = JSON.parse(json);
  return typeof parsed === "string" ? parsed : "";
};

/**
 * What `jj log` prints for the revset's commits with the template, bottom first.
 * `ignoreWorkingCopy` skips the snapshot of the working copy, so the read can run alongside another
 * jj command that takes one.
 */
export const readLog = (
  revset: string,
  template: string,
  { ignoreWorkingCopy = false }: { readonly ignoreWorkingCopy?: boolean } = {},
): Effect.Effect<string, JjFailed, Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    const snapshot = ignoreWorkingCopy ? ["--ignore-working-copy"] : [];
    return yield* jj.read([
      "log",
      ...snapshot,
      "--no-graph",
      "--reversed",
      "-r",
      revset,
      "-T",
      template,
    ]);
  });

const logLines = (revset: string, template: string) =>
  readLog(revset, template).pipe(Effect.map(lines));

/** Each of the revset's changes as its short id and the first line of its description. */
export const changesIn = (revset: string): Effect.Effect<readonly string[], JjFailed, Jj> =>
  logLines(revset, String.raw`change_id.shortest(8) ++ " " ++ description.first_line() ++ "\n"`);

export const commitsAt = (revset: string): Effect.Effect<readonly string[], JjFailed, Jj> =>
  logLines(revset, String.raw`commit_id ++ "\n"`);

export const changeIdsAt = (revset: string): Effect.Effect<readonly string[], JjFailed, Jj> =>
  logLines(revset, String.raw`change_id ++ "\n"`);

/** The names of the local bookmarks on the revset's commits. */
export const bookmarksAt = (revset: string): Effect.Effect<readonly string[], JjFailed, Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    // `jj bookmark list` also prints a bookmark's remote copy where it points elsewhere, as a
    // merged branch's does, so the template keeps the local one alone.
    const template = String.raw`if(!remote, name ++ "\n")`;
    return lines(yield* jj.read(["bookmark", "list", "-r", revset, "-T", template]));
  });

/** Where a bookmark points: locally, and on `origin` as of the last fetch or push. */
export interface BookmarkTarget {
  readonly local: string | undefined;
  readonly origin: string | undefined;
  /** Whether the bookmark tracks its branch on `origin`, which a push needs. */
  readonly tracked: boolean;
}

/** Every bookmark's targets, read in one command. A conflicted bookmark has no local target. */
export const bookmarkTargets: Effect.Effect<
  ReadonlyMap<string, BookmarkTarget>,
  JjFailed,
  Jj
> = Effect.gen(function* () {
  const jj = yield* Jj;
  const template = String.raw`name ++ "\t" ++ remote ++ "\t" ++ tracked ++ "\t" ++ if(normal_target, normal_target.commit_id()) ++ "\n"`;
  const targets = new Map<string, BookmarkTarget>();
  for (const line of lines(yield* jj.read(["bookmark", "list", "--all-remotes", "-T", template]))) {
    const [name = "", remote, tracked, commit] = line.split("\t");
    const known = targets.get(name) ?? { local: undefined, origin: undefined, tracked: false };
    const target = commit === "" ? undefined : commit;
    if (remote === "") {
      targets.set(name, { ...known, local: target });
    } else if (remote === "origin") {
      targets.set(name, { ...known, origin: target, tracked: tracked === "true" });
    }
  }
  return targets;
});

/** One change of a stack, with the bookmark that names its branch. */
export interface StackChange {
  readonly bookmark: string;
  readonly changeId: string;
  readonly commitId: string;
  readonly description: string;
}

export type Pushed = "changed since push" | "not pushed" | "pushed";

/** Whether a change is the commit its bookmark's branch has. */
export const pushedState = (
  target: BookmarkTarget | undefined,
  { commitId }: StackChange,
): Pushed => {
  const onOrigin = target?.origin;
  if (onOrigin === undefined) {
    return "not pushed";
  }
  return onOrigin === commitId ? "pushed" : "changed since push";
};

interface LoggedChange {
  /** Local bookmark names, a conflicted one ending in `?`. */
  readonly bookmarks: readonly string[];
  readonly changeId: string;
  readonly commitId: string;
  readonly conflict: boolean;
  readonly description: string;
  /** The short change id and the first line of the description. */
  readonly label: string;
  readonly parents: readonly string[];
}

// One line per change. The description is JSON, so a tab or a newline in it can't split a field.
const CHANGE = String.raw`change_id.shortest(8) ++ "\t" ++ change_id ++ "\t" ++ commit_id ++ "\t" ++ parents.map(|p| p.commit_id()).join(",") ++ "\t" ++ conflict ++ "\t" ++ local_bookmarks.map(|b| b.name() ++ if(b.conflict(), "?")).join(" ") ++ "\t" ++ description.escape_json() ++ "\n"`;

const loggedChanges = (revset: string) =>
  logLines(revset, CHANGE).pipe(
    Effect.map((logged) =>
      logged.map((line): LoggedChange => {
        const [
          shortId = "",
          changeId = "",
          commitId = "",
          parents = "",
          conflict,
          bookmarks = "",
          json = '""',
        ] = line.split("\t");
        const description = parseDescription(json);
        return {
          bookmarks: bookmarks === "" ? [] : bookmarks.split(" "),
          changeId,
          commitId,
          conflict: conflict === "true",
          description,
          label: `${shortId} ${description.split("\n", 1)[0] ?? ""}`,
          parents: parents.split(","),
        };
      }),
    ),
  );

const notAStack = (message: string, changes: readonly string[]) =>
  Effect.fail(new NotAStack({ message: [message, ...changes].join("\n") }));

const labels = (changes: readonly LoggedChange[]): readonly string[] =>
  changes.map(({ label }) => label);

/**
 * The changes of the revset, bottom to top, each with its bookmark. A GitHub stack must be a
 * chain, but jj allows any history: one head and no merges means the changes form a chain. Each
 * change becomes one pull request, so it needs exactly one bookmark to name its branch.
 */
const chain = (
  revset: string,
  revision: string,
): Effect.Effect<readonly StackChange[], JjFailed | NotAStack, Jj> =>
  Effect.gen(function* () {
    const changes = yield* loggedChanges(revset);
    if (changes.length === 0) {
      return yield* notAStack(
        `\`${revision}\` is on no stack; name a change of one that is based on the trunk, or run \`jj new\` on its top`,
        [],
      );
    }
    const heads = changes.filter(
      ({ commitId }) => !changes.some(({ parents }) => parents.includes(commitId)),
    );
    if (heads.length !== 1) {
      return yield* notAStack(
        "the stack has several heads, and a GitHub stack must be a chain:",
        labels(heads),
      );
    }
    const merges = changes.filter(({ parents }) => parents.length > 1);
    if (merges.length > 0) {
      return yield* notAStack("merge commits can't be pull requests in a stack:", labels(merges));
    }
    const withConflicts = changes.filter(({ conflict }) => conflict);
    if (withConflicts.length > 0) {
      return yield* notAStack("resolve the conflicts first:", labels(withConflicts));
    }
    const unnamed = changes.filter(({ bookmarks }) => bookmarks.length === 0);
    if (unnamed.length > 0) {
      return yield* notAStack(
        "every change needs a bookmark naming its branch; these have none:",
        labels(unnamed),
      );
    }
    const conflicted = changes.flatMap(({ bookmarks }) =>
      bookmarks.filter((name) => name.endsWith("?")).map((name) => name.slice(0, -1)),
    );
    if (conflicted.length > 0) {
      return yield* notAStack(
        "these bookmarks point at two changes, one local and one from GitHub; keep one with `jj bookmark set <name> -r <revision>`:",
        conflicted,
      );
    }
    const several = changes.filter(({ bookmarks }) => bookmarks.length > 1);
    if (several.length > 0) {
      return yield* notAStack(
        "a pull request has one branch, and these changes have several bookmarks:",
        several.map(({ bookmarks }) => bookmarks.join(" ")),
      );
    }
    return changes.map(({ bookmarks, changeId, commitId, description }) => ({
      bookmark: bookmarks[0] ?? "",
      changeId,
      commitId,
      description,
    }));
  });

/** The whole stack containing the revision, bottom to top. */
export const stackChanges = (
  revision: string,
): Effect.Effect<readonly StackChange[], JjFailed | NotAStack, Jj> =>
  chain(stackRevset(revision), revision);

/** The revision's change and the ones below it in its stack, bottom to top. */
export const downstackChanges = (
  revision: string,
): Effect.Effect<readonly StackChange[], JjFailed | NotAStack, Jj> =>
  chain(downstackRevset(revision), revision);
