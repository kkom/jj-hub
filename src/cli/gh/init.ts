import { Console, Effect, type FileSystem, Result, SemVer } from "effect";
import { Command } from "effect/cli";

import manifest from "../../../package.json" with { type: "json" };
import type { Git, GitFailed } from "../../clients/git";
import { type Jj, type JjFailed, setJjConfig } from "../../clients/jj";
import { asUserError, withHelp } from "../command";
import { NotSetUp, SET_UP_VERSION, type SetupStep, readSetUpVersion, runSteps } from "./setup";

/**
 * Runs the fix where the check finds a problem that `init` fixes, and returns what the check finds
 * afterwards, such as a value that a higher config overrides. A check or fix that fails leaves its
 * error as the problem.
 */
const fixed = ({ check, fix }: SetupStep) =>
  Effect.gen(function* () {
    const found = yield* check;
    if (found?.byInit !== true) {
      return found?.message;
    }
    yield* fix;
    const problem = yield* check;
    return problem?.byInit === true
      ? `${problem.message}, though init set it up`
      : problem?.message;
  }).pipe(Effect.catch((error) => Effect.succeed(error.message)));

/**
 * Sets up a git checkout for the other commands: a colocated jj repository with an identity,
 * `origin`'s default branch as `trunk()`, and the `jj gh` alias. Runs every step, and then fails
 * with the problems that remain. Where none remain, records its own version in the repository's
 * config, which `setUpOnUpgrade` reads.
 */
export const init: Effect.Effect<
  void,
  GitFailed | JjFailed | NotSetUp,
  FileSystem.FileSystem | Git | Jj
> = Effect.gen(function* () {
  const { branch, problems } = yield* runSteps(fixed);
  if (problems.length > 0) {
    yield* new NotSetUp({ message: problems.join("\n") });
  }
  yield* setJjConfig(SET_UP_VERSION, manifest.version);
  yield* Console.error(`set up jj, with trunk() as ${yield* branch}@origin`);
});

const THIS_VERSION = SemVer.parseUnsafe(manifest.version);

/** Whether `recorded` is a version older than this one, or isn't a version at all. */
const isOlder = (recorded: unknown): boolean =>
  typeof recorded !== "string" ||
  Result.match(SemVer.parse(recorded), {
    onFailure: () => true,
    onSuccess: (version) => SemVer.isLessThan(version, THIS_VERSION),
  });

/**
 * Runs `init` where an older version, or none, recorded setting the repository up. Where `init`
 * can't set something up, prints what's left and records this version anyway, so each upgrade
 * tries once.
 */
export const setUpOnUpgrade: Effect.Effect<
  void,
  GitFailed | JjFailed,
  FileSystem.FileSystem | Git | Jj
> = Effect.gen(function* () {
  if (!isOlder(yield* readSetUpVersion)) {
    return;
  }
  yield* Console.error(`setting this checkout up for jj-octo ${manifest.version}`);
  yield* init.pipe(
    Effect.catchTag("NotSetUp", ({ message }) =>
      Effect.andThen(
        Console.error(`${message}\nrun \`jj-octo init\` once that's fixed`),
        setJjConfig(SET_UP_VERSION, manifest.version),
      ),
    ),
  );
});

export const initCommand = Command.make("init", {}, () => asUserError(init)).pipe(
  withHelp(
    "Set up a git checkout for the other commands",
    "Makes it a jj repository colocated with git, unless it already is one, and copies git's name and email into the repository's jj config where jj has none. Where neither has them, set them with `jj config set --user`.",
    "Reads the default branch from `origin`, fetches and tracks it, and sets `trunk()` to it in the repository's config. jj's own `trunk()` guesses from branch names, so without this a default branch it doesn't guess would be the base of pull requests but not of local rebases. `submit`, `merge` and `sync` check that the two agree.",
    "Sets the `jj gh` alias to run `jj-octo` from `PATH`, in the repository's config, unless the repository has one, such as one that runs another build.",
    "Records its version as `jj-octo.set-up-version` in the repository's config. The other commands, except `doctor`, run it first where an older version is recorded, or none is.",
    "Needs no GitHub token. Running it again changes nothing that is already set up. Run it again after the default branch changes on GitHub. Fails with what it couldn't set up, after setting up the rest. Where it can't make a colocated jj repository, such as in a git worktree, it sets up nothing else.",
  ),
);
