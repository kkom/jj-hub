import { Console, Effect, type FileSystem } from "effect";
import { Command } from "effect/cli";

import type { Git, GitFailed } from "../../clients/git";
import type { Jj } from "../../clients/jj";
import { asUserError, withHelp } from "../command";
import { NotSetUp, type SetupStep, runSteps } from "./setup";

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
 * with the problems that remain.
 */
export const init: Effect.Effect<void, GitFailed | NotSetUp, FileSystem.FileSystem | Git | Jj> =
  Effect.gen(function* () {
    const { branch, problems } = yield* runSteps(fixed);
    if (problems.length > 0) {
      yield* new NotSetUp({ message: problems.join("\n") });
    }
    yield* Console.error(`set up jj, with trunk() as ${yield* branch}@origin`);
  });

export const initCommand = Command.make("init", {}, () => asUserError(init)).pipe(
  withHelp(
    "Set up a git checkout for the other commands",
    "Makes it a jj repository colocated with git, unless it already is one, and copies git's name and email into the repository's jj config where jj has none. Where neither has them, set them with `jj config set --user`.",
    "Reads the default branch from `origin`, fetches and tracks it, and sets `trunk()` to it in the repository's config. jj's own `trunk()` guesses from branch names, so without this a default branch it doesn't guess would be the base of pull requests but not of local rebases. `submit`, `merge` and `sync` check that the two agree.",
    "Sets the `jj gh` alias to run `jj-octo` from `PATH`, in the repository's config, unless the repository has one, such as one that runs another build.",
    "Needs no GitHub token. Running it again changes nothing that is already set up. Run it again after the default branch changes on GitHub. Fails with what it couldn't set up, after setting up the rest. Where it can't make a colocated jj repository, such as in a git worktree, it sets up nothing else.",
  ),
);
