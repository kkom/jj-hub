import { Console, Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import type { PullRequestNumber } from "./github/types";
import { Jj } from "./jj";

/**
 * The pull request description that a change's description and the pull request's body last
 * agreed on, by pull request number. `submit` reads who edited a description since against it.
 *
 * It's kept per repository, in a file per pull request under `jj-octo/pr-descriptions` in jj's
 * repository directory, which every workspace of the repository shares and neither jj nor git
 * tracks. A record is a hint: one that can't be read counts as missing, and one that can't be
 * written or deleted is reported and skipped.
 */
export class PrDescriptions extends Context.Service<
  PrDescriptions,
  {
    /** The pull request's record, where it was written for the bookmark. */
    readonly read: (
      pullRequest: PullRequestNumber,
      bookmark: string,
    ) => Effect.Effect<Option.Option<PrDescription>>;
    readonly write: (
      record: PrDescription & {
        readonly bookmark: string;
        readonly pullRequest: PullRequestNumber;
      },
    ) => Effect.Effect<void>;
    /**
     * Deletes the records of pull requests whose bookmark isn't one of these, which it reads only
     * where there are records, unreadable records, and what writes that stopped halfway left.
     */
    readonly prune: (
      bookmarks: Effect.Effect<readonly string[], { readonly message: string }>,
    ) => Effect.Effect<void>;
  }
>()("jj-octo/PrDescriptions") {}

/** A description both sides agreed on, and the commit of the change it was agreed for. */
export interface PrDescription {
  readonly commit: string;
  readonly description: string;
}

const StoredRecord = Schema.Struct({
  bookmark: Schema.String,
  commit: Schema.String,
  description: Schema.String,
});
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(StoredRecord));

// A record's file is named by its pull request's number. A write goes to a file named by the
// number and a random id first, which is renamed into place.
const RECORD = /^\d+$/u;
const PARTIAL = /^\d+\.[\da-f-]+\.partial$/u;
// Older than any write takes, which a process stopped halfway left.
const STOPPED_AFTER_MS = 60 * 60 * 1000;

const warn = (action: string) => (error: { readonly message: string }) =>
  Console.error(`couldn't ${action} the agreed pull request descriptions: ${error.message}`);

export const prDescriptionsLayer: Layer.Layer<
  PrDescriptions,
  never,
  FileSystem.FileSystem | Jj | Path.Path
> = Layer.effect(
  PrDescriptions,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const jj = yield* Jj;
    const path = yield* Path.Path;

    // A workspace added with `jj workspace add` has a file in place of the repository directory,
    // holding its path relative to the workspace's `.jj`.
    const directory = yield* Effect.cached(
      Effect.gen(function* () {
        const dotJj = path.join((yield* jj.read(["workspace", "root"])).trim(), ".jj");
        const repository = path.join(dotJj, "repo");
        const shared =
          (yield* fs.stat(repository)).type === "File"
            ? path.resolve(dotJj, (yield* fs.readFileString(repository)).trim())
            : repository;
        return path.join(shared, "jj-octo", "pr-descriptions");
      }),
    );
    // A record that can't be read or decoded is none.
    const recordOf = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.map(decode),
        Effect.orElseSucceed(() => Option.none<typeof StoredRecord.Type>()),
      );
    const remove = (file: string, name: string) =>
      fs.remove(file, { force: true }).pipe(Effect.catch(warn(`prune ${name} in`)));

    return {
      prune: (bookmarks) =>
        Effect.gen(function* () {
          const records = yield* directory;
          const names = (yield* fs.exists(records)) ? yield* fs.readDirectory(records) : [];
          const recorded = names.filter((name) => RECORD.test(name));
          const left = recorded.length === 0 ? [] : yield* bookmarks;
          for (const name of recorded) {
            const file = path.join(records, name);
            const record = yield* recordOf(file);
            if (Option.isNone(record) || !left.includes(record.value.bookmark)) {
              yield* remove(file, name);
            }
          }
          const now = Date.now();
          for (const name of names.filter((file) => PARTIAL.test(file))) {
            const file = path.join(records, name);
            const modified = yield* fs.stat(file).pipe(
              Effect.map(({ mtime }) => Option.getOrElse(mtime, () => new Date(0)).getTime()),
              Effect.orElseSucceed(() => now),
            );
            if (now - modified > STOPPED_AFTER_MS) {
              yield* remove(file, name);
            }
          }
        }).pipe(Effect.catch(warn("prune"))),
      read: (pullRequest, bookmark) =>
        directory.pipe(
          Effect.flatMap((records) => recordOf(path.join(records, String(pullRequest)))),
          Effect.map(Option.filter((record) => record.bookmark === bookmark)),
          Effect.orElseSucceed(() => Option.none()),
        ),
      write: ({ bookmark, commit, description, pullRequest }) =>
        Effect.gen(function* () {
          const records = yield* directory;
          yield* fs.makeDirectory(records, { recursive: true });
          const record = path.join(records, String(pullRequest));
          // Renamed into place, so a run stopped halfway leaves the record whole or as it was.
          const partial = `${record}.${crypto.randomUUID()}.partial`;
          yield* fs
            .writeFileString(partial, JSON.stringify({ bookmark, commit, description }))
            .pipe(
              Effect.andThen(fs.rename(partial, record)),
              Effect.tapError(() => fs.remove(partial, { force: true }).pipe(Effect.ignore)),
            );
        }).pipe(Effect.catch(warn("record"))),
    };
  }),
);
