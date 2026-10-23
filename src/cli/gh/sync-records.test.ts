import { afterAll, describe, expect, it } from "bun:test";

import { Effect, Option } from "effect";

import { PullRequestNumberSchema } from "../../clients/github/types";
import { squashMergeOnGitHub } from "../../testing/branch-changes";
import {
  pushedStack,
  removeScratchRepositories,
  type ScratchRepository,
} from "../../testing/scratch-repository";
import { syncIn } from "../../testing/sync";

afterAll(removeScratchRepositories);

const [one, two] = [PullRequestNumberSchema.make(1), PullRequestNumberSchema.make(2)];

// A stack of `a` and `b`, with a record of each pull request's description.
const recorded = async (): Promise<ScratchRepository> => {
  const repository = pushedStack("a", "b");
  await repository.records((store) =>
    Effect.all([
      store.write({ bookmark: "a", commit: "1", description: "a", pullRequest: one }),
      store.write({ bookmark: "b", commit: "2", description: "b", pullRequest: two }),
    ]),
  );
  return repository;
};

const left = (repository: ScratchRepository) =>
  repository.records((store) =>
    Effect.all([store.read(one, "a"), store.read(two, "b")]).pipe(
      Effect.map((records) =>
        records.map((record) => Option.map(record, ({ description }) => description)),
      ),
    ),
  );

describe("sync", () => {
  it("deletes the recorded descriptions of merged pull requests, and keeps the others", async () => {
    const repository = await recorded();
    squashMergeOnGitHub(repository, "a");
    await syncIn(repository);
    expect(await left(repository)).toStrictEqual([Option.none(), Option.some("b")]);
  });
});
