import { Console, Effect, type FileSystem } from "effect";
import { Command } from "effect/cli";

import type { Git } from "../../clients/git";
import type { Jj } from "../../clients/jj";
import { asUserError, withHelp } from "../command";
import { NotSetUp, type SetupStep, advice, runSteps } from "./setup";

/** The check's problem with what fixes it, where it finds one, or why the check failed. */
const find = ({ check }: SetupStep) =>
  check.pipe(
    Effect.map((problem) => (problem === undefined ? undefined : advice(problem))),
    Effect.catch((error) => Effect.succeed(`could not check: ${error.message}`)),
  );

/**
 * The problem that the check of each of `init`'s steps finds, with what fixes it. A check that
 * fails counts as a problem, such as one that needs `origin` to read the default branch from.
 */
export const problems: Effect.Effect<readonly string[], never, FileSystem.FileSystem | Git | Jj> =
  Effect.map(runSteps(find), ({ problems: found }) => found);

/** Fails with the problems, where there are any. */
export const doctor: Effect.Effect<void, NotSetUp, FileSystem.FileSystem | Git | Jj> = Effect.gen(
  function* () {
    const found = yield* problems;
    if (found.length > 0) {
      yield* new NotSetUp({ message: found.join("\n") });
    }
    yield* Console.error("set up for jj-octo");
  },
);

export const doctorCommand = Command.make("doctor", {}, () => asUserError(doctor)).pipe(
  withHelp(
    "Check that a checkout is set up for the other commands",
    "Runs the checks of everything `init` sets up or requires, and changes nothing. Fails with each problem, and what fixes it.",
  ),
);
