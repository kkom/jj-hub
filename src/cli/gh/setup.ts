import { Data, Effect, FileSystem } from "effect";

import { Git, GitFailed, gitConfig, gitDirectories } from "../../clients/git";
import { Jj, type JjFailed, jjConfig, readJjConfig, setJjConfig } from "../../clients/jj";
import { commitsAt } from "./stack/changes";
import { trunkRevset } from "./stack/trunk";

export class NotSetUp extends Data.TaggedError("NotSetUp")<{ readonly message: string }> {}

type SetupEffect<A> = Effect.Effect<A, GitFailed | JjFailed, FileSystem.FileSystem | Git | Jj>;

/** What a check finds isn't set up, and whether `init` sets it up. */
export interface Problem {
  readonly byInit: boolean;
  readonly message: string;
}

const forInit = (message: string): Problem => ({ byInit: true, message });

/** The problem, with what fixes it. */
export const advice = ({ byInit, message }: Problem): string =>
  byInit ? `${message}; run \`jj-octo init\`` : message;

/** One thing that `init` sets up in a checkout. */
export interface SetupStep {
  /** What isn't set up, or `undefined` where it is set up. Changes nothing. */
  readonly check: SetupEffect<Problem | undefined>;
  /** Sets it up. */
  readonly fix: SetupEffect<void>;
}

/**
 * The branch `origin`'s HEAD names, which on GitHub is the default branch. Read from the remote
 * itself, so it needs no token.
 */
const defaultBranch = Effect.gen(function* () {
  const git = yield* Git;
  const output = yield* git.read(["ls-remote", "--symref", "origin", "HEAD"]);
  const branch = /^ref: refs\/heads\/(?<branch>\S+)\tHEAD$/mu.exec(output)?.groups?.["branch"];
  if (branch === undefined) {
    return yield* new GitFailed({ message: "origin names no default branch" });
  }
  return branch;
});

/**
 * The checkout's directory, and whether it's a git worktree or a colocated jj repository. Read
 * from the files rather than from jj, which fails the same way outside a jj repository as on a
 * config it can't parse.
 */
const checkout = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { commonDirectory, gitDirectory, topLevel: root } = yield* gitDirectories;
  const isColocated = yield* fs.exists(`${root}/.jj`).pipe(Effect.orElseSucceed(() => false));
  return { isColocated, isWorktree: gitDirectory !== commonDirectory, root };
});

/** The jj config key that records which version of jj-octo last set the checkout up. */
export const SET_UP_VERSION = "jj-octo.set-up-version";

/** The version of jj-octo whose `init` last set the repository up, or `undefined` where none did. */
export const readSetUpVersion = readJjConfig(SET_UP_VERSION, { repo: true });

/**
 * Makes the git checkout a colocated jj repository. A jj repository further up, holding the
 * checkout as an ordinary directory, doesn't count. A git worktree stays as it is, since a jj
 * repository there would be a second one over the same git repository, and share its branches.
 */
const colocated: SetupStep = {
  check: Effect.map(checkout, ({ isColocated, isWorktree }) => {
    const problem = isWorktree
      ? {
          byInit: false,
          message:
            "this is a git worktree, where jj would make a second repository; run `jj workspace add` in the main checkout instead",
        }
      : forInit("this checkout isn't a jj repository colocated with git");
    return isColocated ? undefined : problem;
  }),
  fix: Effect.gen(function* () {
    const jj = yield* Jj;
    const { root } = yield* checkout;
    yield* jj.run(["git", "init", "--colocate", root]);
  }),
};

const IDENTITY = ["user.name", "user.email"];

/**
 * Copies git's name or email into the repository's jj config where jj has none, as in a fresh
 * container that configures git alone. A change jj makes without them has no author, and can't
 * be pushed.
 */
const identity = (key: string): SetupStep => ({
  check: Effect.gen(function* () {
    const inJj = (yield* jjConfig(key)) !== "";
    const inGit = !inJj && (yield* gitConfig([key])) !== "";
    const problem = inGit
      ? forInit(`jj has no ${key}, which git has`)
      : {
          byInit: false,
          message: `neither jj nor git has ${key}; set it with \`jj config set --user ${key}\``,
        };
    return inJj ? undefined : problem;
  }),
  fix: Effect.gen(function* () {
    yield* setJjConfig(key, yield* gitConfig([key]));
  }),
});

// Changes jj made before it had an identity have no author, and can't be pushed.
const ANONYMOUS = 'mutable() & (author_name(exact:"") | author_email(exact:""))';

/** Gives those changes jj's identity, which the identity step reports where jj has none. */
const authors: SetupStep = {
  check: Effect.gen(function* () {
    const values = yield* Effect.forEach(IDENTITY, jjConfig);
    const hasIdentity = values.every((value) => value !== "");
    const isAnonymous = hasIdentity && (yield* commitsAt(ANONYMOUS)).length > 0;
    return isAnonymous ? forInit("some mutable changes have no author") : undefined;
  }),
  fix: Effect.gen(function* () {
    const jj = yield* Jj;
    yield* jj.run(["metaedit", "--quiet", "--update-author", "-r", ANONYMOUS]);
  }),
};

/** Whether `origin`'s branch is fetched and tracked. */
const isTracked = (branch: string) =>
  Effect.map(
    commitsAt(`tracked_remote_bookmarks(exact:${JSON.stringify(branch)}, remote=exact:"origin")`),
    (commits) => commits.length > 0,
  );

/**
 * Whether the `trunk()` alias names the branch, as `fix` writes it or as jj does when it colocates.
 * Compared as text, since another branch can be on the same commit, until one of them moves.
 */
const namesTrunk = (branch: string) =>
  Effect.map(
    jjConfig('revset-aliases."trunk()"'),
    (alias) => alias === trunkRevset(branch) || alias === `${branch}@origin`,
  );

/** Tracks the default branch, fetching it if needed, and makes it `trunk()`. */
const trunk = (branchOnOrigin: Effect.Effect<string, GitFailed, Git>): SetupStep => ({
  check: Effect.gen(function* () {
    const branch = yield* branchOnOrigin;
    return (yield* isTracked(branch)) && (yield* namesTrunk(branch))
      ? undefined
      : forInit(`trunk() isn't ${branch}@origin, GitHub's default branch, fetched and tracked`);
  }),
  fix: Effect.gen(function* () {
    const jj = yield* Jj;
    const branch = yield* branchOnOrigin;
    if ((yield* commitsAt(`present(${trunkRevset(branch)})`)).length === 0) {
      yield* jj.run(["git", "fetch", "--remote", "origin", "--branch", `exact:${branch}`]);
    }
    if (!(yield* isTracked(branch))) {
      yield* jj.run(["bookmark", "track", `exact:${branch}`, "--remote", "origin"]);
    }
    if (!(yield* namesTrunk(branch))) {
      yield* setJjConfig('revset-aliases."trunk()"', trunkRevset(branch));
    }
  }),
});

/**
 * The `jj gh` alias, set to run jj-octo from `PATH` where the repository has none. One that runs
 * another build stays. Jj reads aliases from user and repository config, never from a tracked file.
 */
const alias: SetupStep = {
  // The repository's config, where `fix` writes, rather than one that the user's config shadows.
  check: Effect.map(readJjConfig("aliases.gh", { repo: true }), (value) =>
    value === undefined ? forInit("`jj gh` isn't set up") : undefined,
  ),
  fix: setJjConfig("aliases.gh", ["util", "exec", "--", "jj-octo"]),
};

/**
 * The steps of `init` after `colocated`, in the order it runs them, and the default branch they
 * read once, on first use.
 */
const setup = Effect.map(Effect.cached(defaultBranch), (branch) => ({
  branch,
  steps: [...IDENTITY.map((key) => identity(key)), authors, trunk(branch), alias],
}));

/**
 * Runs `run` on each step of `init`, and returns the problems it finds, with the default branch
 * the steps read, each problem once. Without a colocated jj repository, it runs no other step,
 * since they read it.
 * `init` runs the fixes this way, and `doctor` the checks.
 */
export const runSteps = <R>(
  run: (step: SetupStep) => Effect.Effect<string | undefined, never, R>,
): Effect.Effect<
  { readonly branch: Effect.Effect<string, GitFailed, Git>; readonly problems: readonly string[] },
  never,
  R
> =>
  Effect.gen(function* () {
    const { branch, steps } = yield* setup;
    const notColocated = yield* run(colocated);
    const found =
      notColocated === undefined
        ? yield* Effect.forEach(steps, (step) => run(step))
        : [notColocated];
    // Steps that fail the same way, such as on a jj config that jj can't parse, report it once.
    const problems = new Set(found.filter((problem) => problem !== undefined));
    return { branch, problems: [...problems] };
  });
