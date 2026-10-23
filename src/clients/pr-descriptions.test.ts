import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Effect, Option } from "effect";

import {
  removeScratchRepositories,
  type ScratchRepository,
  scratchRepository,
} from "../testing/scratch-repository";
import { PullRequestNumberSchema } from "./github/types";
import { PrDescriptions } from "./pr-descriptions";

afterAll(removeScratchRepositories);

const pullRequest = PullRequestNumberSchema.make(7);
const record = { bookmark: "a", commit: "abc", description: "a\n\nbody", pullRequest };

const recordsDirectory = (repository: ScratchRepository): string =>
  path.join(repository.jj("workspace", "root").trim(), ".jj", "repo", "jj-octo", "pr-descriptions");

describe("PrDescriptions", () => {
  it("shares its records with a workspace added to the repository", async () => {
    const repository = scratchRepository();
    const workspace = path.join(
      path.dirname(repository.jj("workspace", "root").trim()),
      "workspace",
    );
    repository.jj("workspace", "add", "--quiet", workspace);
    await repository.records((store) => store.write(record));
    const read = await Effect.runPromise(
      Effect.flatMap(PrDescriptions, (store) => store.read(pullRequest, "a")).pipe(
        Effect.provide(repository.layerAt(workspace)),
      ),
    );
    expect(read).toStrictEqual(
      Option.some({ bookmark: "a", commit: "abc", description: "a\n\nbody" }),
    );
  });

  it("reads no record written for another bookmark", async () => {
    const repository = scratchRepository();
    await repository.records((store) => store.write(record));
    expect(await repository.records((store) => store.read(pullRequest, "b"))).toStrictEqual(
      Option.none(),
    );
  });

  it("reads no record for a pull request it never recorded", async () => {
    const repository = scratchRepository();
    expect(await repository.records((store) => store.read(pullRequest, "a"))).toStrictEqual(
      Option.none(),
    );
  });

  it("prunes the records of other bookmarks and the unreadable ones", async () => {
    const repository = scratchRepository();
    const other = PullRequestNumberSchema.make(8);
    await repository.records((store) =>
      Effect.all([
        store.write(record),
        store.write({ ...record, bookmark: "b", pullRequest: other }),
      ]),
    );
    writeFileSync(path.join(recordsDirectory(repository), "9"), "not json");
    await repository.records((store) => store.prune(Effect.succeed(["a"])));
    expect(readdirSync(recordsDirectory(repository))).toStrictEqual(["7"]);
  });

  it("reads no bookmarks to prune where there are no records", async () => {
    const repository = scratchRepository();
    let isRead = false;
    await repository.records((store) =>
      store.prune(
        Effect.sync(() => {
          isRead = true;
          return [];
        }),
      ),
    );
    expect(isRead).toBe(false);
  });

  it("prunes what a write that stopped an hour ago left, and keeps a recent one", async () => {
    const repository = scratchRepository();
    await repository.records((store) => store.write(record));
    const directory = recordsDirectory(repository);
    const stopped = path.join(directory, "8.0b6e4a.partial");
    const recent = path.join(directory, "8.9f1c2d.partial");
    writeFileSync(stopped, "{");
    writeFileSync(recent, "{");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stopped, twoHoursAgo, twoHoursAgo);
    await repository.records((store) => store.prune(Effect.succeed(["a"])));
    expect([existsSync(stopped), existsSync(recent)]).toStrictEqual([false, true]);
  });
});
