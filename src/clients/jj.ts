import { Context, Data, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class JjFailed extends Data.TaggedError("JjFailed")<{ readonly message: string }> {}

export class Jj extends Context.Service<
  Jj,
  {
    /** Runs a jj command that reads the repository, and returns what it printed. */
    readonly read: (args: readonly string[]) => Effect.Effect<string, JjFailed>;
    /** Runs a jj command that changes something, showing its output as it goes. */
    readonly run: (args: readonly string[]) => Effect.Effect<void, JjFailed>;
  }
>()("jj-octo/Jj") {}

// What jj printed says what went wrong, so it's the message. The command is named only where jj
// printed nothing to this program: it failed to start, or its output went to the terminal.
const failed = (args: readonly string[], detail: string): JjFailed =>
  new JjFailed({
    message:
      detail.trim() === "" ? `jj ${args.join(" ")} failed` : detail.trim().replace(/^Error: /u, ""),
  });

interface JjOptions {
  readonly cwd?: string;
  /** Added to the environment jj inherits. */
  readonly env?: Readonly<Record<string, string>>;
  /** Discards what `run` commands print, which otherwise goes to the terminal. */
  readonly quiet?: boolean;
}

export const jjLayer = ({ cwd, env, quiet = false }: JjOptions = {}): Layer.Layer<
  Jj,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.effect(
    Jj,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const location = { cwd, env, extendEnv: true };
      const output = quiet ? "ignore" : "inherit";

      const read = (args: readonly string[]): Effect.Effect<string, JjFailed> =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(ChildProcess.make("jj", args, location));
            const [stdout, stderr, code] = yield* Effect.all(
              [
                Stream.mkString(Stream.decodeText(handle.stdout)),
                Stream.mkString(Stream.decodeText(handle.stderr)),
                handle.exitCode,
              ],
              { concurrency: "unbounded" },
            );
            return code === 0 ? stdout : yield* failed(args, stderr);
          }),
        ).pipe(
          Effect.catchTag("PlatformError", (error) => Effect.fail(failed(args, error.message))),
        );

      const run = (args: readonly string[]): Effect.Effect<void, JjFailed> =>
        spawner
          .exitCode(ChildProcess.make("jj", args, { ...location, stderr: output, stdout: output }))
          .pipe(
            Effect.catchTag("PlatformError", (error) => Effect.fail(failed(args, error.message))),
            Effect.flatMap((code) => (code === 0 ? Effect.void : Effect.fail(failed(args, "")))),
          );

      return { read, run };
    }),
  );

export const JjLive = jjLayer();

const ENTRY = String.raw`json(name) ++ " " ++ json(value) ++ "\n"`;

/**
 * A key's value in jj's config, or `undefined` where it has none. `jj config list` prints nothing
 * for a key without a value, where `jj config get` fails.
 */
const readConfig = (key: string): Effect.Effect<unknown, JjFailed, Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    const output = yield* jj.read(["config", "list", key, "-T", ENTRY]);
    const lines = output.split("\n").filter((line) => line !== "");
    // For a table, jj lists the keys inside it.
    const prefix = `${JSON.stringify(key)} `;
    if (lines.some((line) => !line.startsWith(prefix))) {
      return yield* new JjFailed({ message: `${key} is a table; set it to a single value` });
    }
    const [line] = lines;
    return line === undefined ? undefined : (JSON.parse(line.slice(prefix.length)) as unknown);
  });

/** A string in jj's config, or an empty string where it has none. Fails on any other value. */
export const jjConfig = (key: string): Effect.Effect<string, JjFailed, Jj> =>
  Effect.gen(function* () {
    const value = yield* readConfig(key);
    if (value === undefined || typeof value === "string") {
      return value ?? "";
    }
    return yield* new JjFailed({
      message: `${key} is ${JSON.stringify(value)}; set it to a string`,
    });
  });

/** A true-or-false value in jj's config, false where it has none. Fails on any other value. */
export const jjFlag = (key: string): Effect.Effect<boolean, JjFailed, Jj> =>
  Effect.gen(function* () {
    const value = yield* readConfig(key);
    if (value === undefined || typeof value === "boolean") {
      return value === true;
    }
    return yield* new JjFailed({
      message: `${key} is ${JSON.stringify(value)}; set it to true or false`,
    });
  });

/**
 * Sets a value in the repository's jj config. Jj parses the value as TOML, so a string or an array
 * goes in as JSON writes it, which is also TOML.
 */
export const setJjConfig = (
  key: string,
  value: string | readonly string[],
): Effect.Effect<void, JjFailed, Jj> =>
  Effect.gen(function* () {
    const jj = yield* Jj;
    yield* jj.run(["config", "set", "--repo", key, JSON.stringify(value)]);
  });
