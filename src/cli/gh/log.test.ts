import { afterAll, describe, expect, it } from "bun:test";

import { Effect, Option } from "effect";

import { fakeGitHub, inRepository, openPullRequest } from "../../testing/fake-github";
import { removeScratchRepositories, scratchRepository } from "../../testing/scratch-repository";
import { log } from "./log";

afterAll(removeScratchRepositories);

describe("log", () => {
  it("prints each change top first, with its pull request and whether it is pushed", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b", "c");
    repository.jj("git", "push", "--bookmark", "a", "--bookmark", "b");
    repository.jj("describe", "-r", "b", "-m", "b, reworded");
    const github = fakeGitHub(
      { a: { ...openPullRequest("main", 1, "a"), draft: false }, b: openPullRequest("a", 2, "b") },
      Option.none(),
    );
    const printed = await Effect.runPromise(log("@").pipe(inRepository(repository, github)));
    expect(printed).toEqual([
      "c  no pull request  not pushed",
      "b  #2 draft         changed since push",
      "a  #1 ready         pushed",
    ]);
  });
});
