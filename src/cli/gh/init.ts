import { Console, Effect, FileSystem } from "effect";
import { Command } from "effect/cli";

import { Git, GitFailed } from "../../clients/git";
import { Jj, type JjFailed } from "../../clients/jj";
import { asUserError, withHelp } from "../command";
import { bookmarkTargets, commitsAt } from "./stack/changes";
import { trunkRevset } from "./stack/trunk";

/**
 * Makes the git checkout a colocated jj repository. A jj repository further up, holding the
 * checkout as an ordinary directory, doesn't count. A git worktree stays as it is, since a jj
 * repository there would be a second one over the same git repository, and share its branches.
 */
const colocate = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const git = yield* Git;
  const jj = yield* Jj;
  // Resolved, because the two can spell one directory differently through a symlink.
  const resolve = (output: string) =>
    fs.realPath(output.trim()).pipe(Effect.orElseSucceed(() => ""));
  const root = yield* resolve(yield* git.read(["rev-parse", "--show-toplevel"]));
  // Jj fails outside a jj repository.
  const jjRoot = yield* jj.read(["root"]).pipe(
    Effect.flatMap(resolve),
    Effect.orElseSucceed(() => ""),
  );
  if (jjRoot !== root) {
    const [gitDirectory, commonDirectory] = (yield* git.read([
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
    ])).split("\n");
    if (gitDirectory !== commonDirectory) {
      yield* new GitFailed({
        message:
          "this is a git worktree, where jj would make a second repository; run `jj workspace add` in the main checkout instead",
      });
    }
    yield* jj.run(["git", "init", "--colocate", root]);
  }
});

/**
 * Copies git's name and email into the repository's jj config where jj has none, as in a fresh
 * container that configures git alone. A change jj makes without them has no author, and can't
 * be pushed.
 */
const copyIdentity = Effect.gen(function* () {
  const git = yield* Git;
  const jj = yield* Jj;
  for (const key of ["user.name", "user.email"]) {
    const own = (yield* jj.read(["config", "get", key])).trim();
    // Git exits 1 for a key it has no value for.
    const value = (yield* git.read(["config", key]).pipe(Effect.orElseSucceed(() => ""))).trim();
    if (own === "" && value !== "") {
      // Jj parses the value as TOML, which a name such as `renovate[bot]` isn't, so it goes in as a
      // TOML string.
      yield* jj.run(["config", "set", "--repo", key, JSON.stringify(value)]);
    }
  }
});

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

/** Tracks the default branch, fetching it if needed, and makes it `trunk()`. */
const setTrunk = Effect.gen(function* () {
  const jj = yield* Jj;
  const branch = yield* defaultBranch;
  if ((yield* commitsAt(`present(${trunkRevset(branch)})`)).length === 0) {
    yield* jj.run(["git", "fetch", "--remote", "origin", "--branch", `exact:${branch}`]);
  }
  if ((yield* bookmarkTargets).get(branch)?.tracked !== true) {
    yield* jj.run(["bookmark", "track", `exact:${branch}`, "--remote", "origin"]);
  }
  // Jj parses the value as TOML, so the revset goes in as a TOML string.
  yield* jj.run([
    "config",
    "set",
    "--repo",
    'revset-aliases."trunk()"',
    JSON.stringify(trunkRevset(branch)),
  ]);
  return branch;
});

/**
 * Sets up a git checkout for the other commands: a colocated jj repository with an identity,
 * `origin`'s default branch as `trunk()`, and the `jj gh` alias.
 */
export const init: Effect.Effect<void, GitFailed | JjFailed, FileSystem.FileSystem | Git | Jj> =
  Effect.gen(function* () {
    const jj = yield* Jj;
    yield* colocate;
    yield* copyIdentity;
    // Changes jj made before it had an identity have no author, and can't be pushed.
    const anonymous = 'mutable() & (author_name(exact:"") | author_email(exact:""))';
    if ((yield* commitsAt(anonymous)).length > 0) {
      yield* jj.run(["metaedit", "--quiet", "--update-author", "-r", anonymous]);
    }
    const branch = yield* setTrunk;
    // Jj reads aliases from user and repository config, never from a tracked file.
    yield* jj.run([
      "config",
      "set",
      "--repo",
      "aliases.gh",
      JSON.stringify(["util", "exec", "--", "jj-octo"]),
    ]);
    yield* Console.error(`set up jj, with trunk() as ${branch}@origin`);
  });

export const initCommand = Command.make("init", {}, () => asUserError(init)).pipe(
  withHelp(
    "Set up a git checkout for the other commands",
    "Makes it a jj repository colocated with git, unless it already is one, and copies git's name and email into the repository's jj config where jj has none.",
    "Reads the default branch from `origin`, fetches and tracks it, and sets `trunk()` to it in the repository's config. jj's own `trunk()` guesses from branch names, so without this a default branch it doesn't guess would be the base of pull requests but not of local rebases. `submit`, `merge` and `sync` check that the two agree.",
    "Sets the `jj gh` alias to run `jj-octo` from `PATH`, in the repository's config. Set it again afterwards to run another build.",
    "Needs no GitHub token. Running it again changes nothing that is already set up. Run it again after the default branch changes on GitHub.",
  ),
);
