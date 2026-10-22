import { Context, Data, Effect, FileSystem, Layer, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class GitFailed extends Data.TaggedError("GitFailed")<{
  readonly message: string;
  /** Git's exit code, where git ran and failed. */
  readonly exitCode?: number;
}> {}

export class Git extends Context.Service<
  Git,
  {
    /** Runs a git command that reads the repository, and returns what it printed. */
    readonly read: (args: readonly string[]) => Effect.Effect<string, GitFailed>;
    /**
     * Merges two edits of a text, line by line. Where both changed the same lines, the text has
     * conflict markers around the two versions, labelled `local` and `GitHub`.
     */
    readonly mergeText: (texts: {
      readonly base: string;
      readonly local: string;
      readonly remote: string;
    }) => Effect.Effect<{ readonly conflicted: boolean; readonly text: string }, GitFailed>;
  }
>()("jj-octo/Git") {}

interface GitOptions {
  readonly cwd?: string;
  /** Added to the environment git inherits. */
  readonly env?: Readonly<Record<string, string>>;
}

export const gitLayer = ({ cwd, env }: GitOptions = {}): Layer.Layer<
  Git,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Layer.effect(
    Git,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      return {
        mergeText: ({ base, local, remote }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const directory = yield* fs.makeTempDirectoryScoped();
              // `git merge-file` merges lines, and treats a last line with no newline as changed.
              const written = { base: `${base}\n`, github: `${remote}\n`, local: `${local}\n` };
              yield* Effect.all(
                Object.entries(written).map(([name, text]) =>
                  fs.writeFileString(path.join(directory, name), text),
                ),
              );
              const handle = yield* spawner.spawn(
                ChildProcess.make(
                  "git",
                  [
                    "merge-file",
                    "-p",
                    "-L",
                    "local",
                    "-L",
                    "base",
                    "-L",
                    "GitHub",
                    "local",
                    "base",
                    "github",
                  ],
                  { cwd: directory },
                ),
              );
              const [text, stderr, code] = yield* Effect.all(
                [
                  Stream.mkString(Stream.decodeText(handle.stdout)),
                  Stream.mkString(Stream.decodeText(handle.stderr)),
                  handle.exitCode,
                ],
                { concurrency: "unbounded" },
              );
              // The exit code is the number of conflicts, and 255 for a failure.
              if (code > 127) {
                return yield* new GitFailed({ message: `git merge-file failed: ${stderr.trim()}` });
              }
              return { conflicted: code > 0, text: text.trimEnd() };
            }),
          ).pipe(
            Effect.catchTag("PlatformError", (error) =>
              Effect.fail(new GitFailed({ message: `git merge-file failed: ${error.message}` })),
            ),
          ),
        read: (args) =>
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make("git", args, { cwd, env, extendEnv: true }),
              );
              const [stdout, stderr, code] = yield* Effect.all(
                [
                  Stream.mkString(Stream.decodeText(handle.stdout)),
                  Stream.mkString(Stream.decodeText(handle.stderr)),
                  handle.exitCode,
                ],
                { concurrency: "unbounded" },
              );
              return code === 0
                ? stdout
                : yield* new GitFailed({
                    exitCode: code,
                    message: `git ${args.join(" ")} failed${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`,
                  });
            }),
          ).pipe(
            Effect.catchTag("PlatformError", (error) =>
              Effect.fail(
                new GitFailed({ message: `git ${args.join(" ")} failed: ${error.message}` }),
              ),
            ),
          ),
      };
    }),
  );

export const GitLive = gitLayer();

/** What a `git config` query prints, or an empty string where it finds no value. */
export const gitConfig = (args: readonly string[]): Effect.Effect<string, GitFailed, Git> =>
  Effect.gen(function* () {
    const git = yield* Git;
    const value = yield* git.read(["config", ...args]).pipe(
      // Git exits 1 for a key it has no value for, and 128 for a config file it can't parse.
      Effect.catch((error) => (error.exitCode === 1 ? Effect.succeed("") : Effect.fail(error))),
    );
    return value.trim();
  });

/**
 * The checkout's top directory, its git directory and the repository's common git directory, as
 * absolute paths. In a git worktree, the git directory isn't the common one.
 */
export const gitDirectories: Effect.Effect<
  { readonly commonDirectory: string; readonly gitDirectory: string; readonly topLevel: string },
  GitFailed,
  Git
> = Effect.gen(function* () {
  const git = yield* Git;
  const [topLevel = "", gitDirectory = "", commonDirectory = ""] = (yield* git.read([
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
  ])).split("\n");
  return { commonDirectory, gitDirectory, topLevel };
});
