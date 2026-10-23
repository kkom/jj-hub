import { afterAll, describe, expect, it } from "bun:test";

import { Effect } from "effect";

import { PullRequestNumberSchema } from "../../../clients/github/types";
import { removeScratchRepositories } from "../../../testing/scratch-repository";
import { description, githubWith, pushed, submitIn } from "../../../testing/submit";

afterAll(removeScratchRepositories);

describe("submit, with the recorded descriptions", () => {
  it("merges a GitHub edit with a local edit pushed without submit, from the recorded description", async () => {
    const repository = pushed();
    await Effect.runPromise(submitIn(repository, githubWith("a", "first\n\nsecond")));
    repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
    repository.jj("git", "push", "--bookmark", "a");
    const github = githubWith("a", "first\n\nsecond, reworded");
    await Effect.runPromise(submitIn(repository, github));
    expect(description(repository, "a")).toBe("a better\n\nfirst\n\nsecond, reworded");
    expect(github.calls).toEqual(["describe #1 as a better"]);
  });

  it("merges edits on both sides against the record of the commit the change was made from", async () => {
    const repository = pushed();
    const commit = repository.jj("log", "--no-graph", "-r", "a", "-T", "commit_id");
    const pullRequest = PullRequestNumberSchema.make(1);
    const agreed = { bookmark: "a", commit, description: "a\n\nfirst\n\nsecond", pullRequest };
    await repository.records((store) => store.write(agreed));
    repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
    repository.jj("git", "push", "--bookmark", "a");
    const github = githubWith("a", "first\n\nsecond, reworded");
    await Effect.runPromise(submitIn(repository, github));
    expect(description(repository, "a")).toBe("a better\n\nfirst\n\nsecond, reworded");
    expect(github.calls).toEqual(["describe #1 as a better"]);
  });

  it("ignores a record of a commit that another clone's push replaced", async () => {
    const repository = pushed();
    const commit = repository.jj("log", "--no-graph", "-r", "a", "-T", "commit_id");
    const pullRequest = PullRequestNumberSchema.make(1);
    const agreed = { bookmark: "a", commit, description: "a\n\nfirst\n\nsecond", pullRequest };
    await repository.records((store) => store.write(agreed));
    repository.elsewhere("git", "fetch");
    repository.elsewhere("bookmark", "track", "a@origin", "b@origin");
    repository.elsewhere("describe", "-r", "a", "-m", "a\n\nfirst\n\nsecond, elsewhere");
    repository.elsewhere("git", "push", "--bookmark", "a");
    repository.jj("git", "fetch");
    repository.jj("describe", "-r", "a", "-m", "a\n\nfirst\n\nsecond, here");
    const github = githubWith("a", "first\n\nsecond, elsewhere");
    await Effect.runPromise(submitIn(repository, github, { revision: "b" }));
    expect(github.calls).toEqual(["describe #1 as a"]);
  });

  it("reads against a pushed description that GitHub took after the record", async () => {
    const repository = pushed();
    const commit = repository.jj("log", "--no-graph", "-r", "a", "-T", "commit_id");
    const pullRequest = PullRequestNumberSchema.make(1);
    const agreed = { bookmark: "a", commit, description: "a\n\nfirst\n\nsecond", pullRequest };
    await repository.records((store) => store.write(agreed));
    repository.jj("describe", "-r", "a", "-m", "a\n\nfirst\n\nsecond, two");
    repository.jj("git", "push", "--bookmark", "a");
    // Another clone submitted the push, which sent its description to GitHub.
    repository.jj("describe", "-r", "a", "-m", "a\n\nfirst\n\nsecond, three");
    const github = githubWith("a", "first\n\nsecond, two");
    await Effect.runPromise(submitIn(repository, github));
    expect(github.calls).toEqual(["describe #1 as a"]);
  });

  it("takes a description set back on GitHub to one the change had", async () => {
    const repository = pushed();
    repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
    await Effect.runPromise(submitIn(repository, githubWith("a", "first\n\nsecond")));
    const github = githubWith("a", "first\n\nsecond");
    await Effect.runPromise(submitIn(repository, github));
    expect(description(repository, "a")).toBe("a\n\nfirst\n\nsecond");
    expect(github.calls).toEqual([]);
  });
});
