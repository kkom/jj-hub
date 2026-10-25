import { afterAll, describe, expect, it } from "bun:test";

import { Effect, Option } from "effect";

import {
  addCommitOnGitHub,
  moveTrunkOnGitHub,
  rebaseOnGitHub,
  squashMergeOnGitHub,
} from "../../../testing/branch-changes";
import { fakeGitHub, inRepository, openPullRequest } from "../../../testing/fake-github";
import {
  pushedStack,
  removeScratchRepositories,
  type ScratchRepository,
} from "../../../testing/scratch-repository";
import { submit } from "./publish";

afterAll(removeScratchRepositories);

// GitHub has the given open pull requests, and reports the ones `squashMergeOnGitHub` merged.
const submitting = (
  repository: ScratchRepository,
  open: Parameters<typeof fakeGitHub>[0],
  revision: string,
) => {
  const github = fakeGitHub(open, Option.none(), { pullRequestsFrom: repository.pullRequestsFrom });
  return {
    calls: github.calls,
    program: submit(revision, { draft: true, overwriteDescriptions: false }).pipe(
      inRepository(repository, github),
    ),
  };
};

const submitIn = (
  repository: ScratchRepository,
  open: Parameters<typeof fakeGitHub>[0],
  revision = "@",
) => {
  const { calls, program } = submitting(repository, open, revision);
  return { calls, run: Effect.runPromise(program) };
};

// What the submit failed with, as it would print it.
const failureIn = (
  repository: ScratchRepository,
  open: Parameters<typeof fakeGitHub>[0],
  revision = "@",
): Promise<string> =>
  Effect.runPromise(Effect.flip(submitting(repository, open, revision).program)).then(
    ({ message }) => message,
  );

const deletedFailure = (...branches: readonly string[]): string =>
  [
    "these branches were deleted on GitHub, so nothing was changed:",
    ...branches,
    "to push a change again, run `jj bookmark forget --include-remotes <name>`, then `jj bookmark create <name> -r <change>`; to drop one, run `jj abandon <change>`",
  ].join("\n");

describe("submit, where the stack changed on GitHub", () => {
  it("drops a merged change and takes the rest of the stack as GitHub rebased it", async () => {
    const repository = pushedStack("a", "b");
    squashMergeOnGitHub(repository, "a", { above: ["b"] });
    const onGitHub = repository.branches();
    const { calls, run } = submitIn(repository, { b: openPullRequest("main", 2, "b") });
    await run;
    expect(repository.log()).toEqual(["b [b]"]);
    expect(repository.branches()).toEqual(onGitHub);
    expect(calls).toEqual([]);
  });

  // A sync between the push and the merge rebased the stack locally.
  it("drops a merged change that was rebased locally since its push", async () => {
    const repository = pushedStack("a", "b");
    moveTrunkOnGitHub(repository);
    repository.jj("git", "fetch");
    repository.jj("rebase", "--source", "a", "--destination", "main@origin");
    squashMergeOnGitHub(repository, "a", { above: ["b"] });
    const { calls, run } = submitIn(repository, { b: openPullRequest("main", 2, "b") });
    await run;
    expect(repository.log()).toEqual(["b [b]"]);
    expect(calls).toEqual([]);
  });

  it("folds a commit GitHub added into its change before pushing over it", async () => {
    const repository = pushedStack("a", "b");
    addCommitOnGitHub(repository, "a");
    repository.jj("edit", "b");
    repository.write("b.txt", "b, edited\n");
    const { run } = submitIn(repository, {
      a: openPullRequest("main", 1, "a"),
      b: openPullRequest("a", 2, "b"),
    });
    await run;
    expect(repository.log()).toEqual(["a [a]", "b [b]"]);
    expect(repository.files("a")).toEqual(["a.txt", "base.txt", "suggestion.txt"]);
    repository.git("fetch", "--quiet");
    expect(repository.git("show", "origin/b:b.txt")).toBe("b, edited\n");
  });

  it("leaves the other stacks where they were", async () => {
    const repository = pushedStack("a", "b");
    repository.jj("new", "main", "-m", "c");
    repository.jj("bookmark", "create", "c", "-r", "@");
    moveTrunkOnGitHub(repository);
    squashMergeOnGitHub(repository, "a", { above: ["b"] });
    const { run } = submitIn(repository, { b: openPullRequest("main", 2, "b") }, "b");
    await run;
    expect(repository.jj("log", "--no-graph", "-r", "c-", "-T", "description")).toBe("base\n");
    expect(repository.files("b")).toEqual(["a.txt", "b.txt", "base.txt", "trunk.txt"]);
  });

  // GitHub rewrote `a` onto a trunk that has moved on since, so the sync rebases the stack again.
  it("rebases onto the trunk a stack whose bottom GitHub rewrote", async () => {
    const repository = pushedStack("a", "b");
    rebaseOnGitHub(repository, "a");
    moveTrunkOnGitHub(repository, "later.txt");
    const { run } = submitIn(repository, {
      a: openPullRequest("main", 1, "a"),
      b: openPullRequest("a", 2, "b"),
    });
    await run;
    expect(repository.log()).toEqual(["a [a]", "b [b]"]);
    expect(repository.files("b")).toEqual(["a.txt", "b.txt", "base.txt", "later.txt", "trunk.txt"]);
  });

  // A pull request merged into the branch below it, not the trunk, leaves that branch to submit.
  it("submits what is left below a change whose pull request merged into its base", async () => {
    const repository = pushedStack("a", "b");
    squashMergeOnGitHub(repository, "b", { deleted: false, into: "a" });
    const onGitHub = repository.branches();
    const { calls, run } = submitIn(repository, { a: openPullRequest("main", 1, "a") }, "b");
    await run;
    expect(repository.log()).toEqual(["a [a]"]);
    expect(repository.files("a")).toEqual(["a.txt", "b.txt", "base.txt"]);
    expect(repository.branches()).toEqual({
      ...onGitHub,
      a: repository.jj("log", "--no-graph", "-r", "a", "-T", "commit_id"),
    });
    expect(calls).toEqual([]);
  });

  it("stops before changing anything where a branch was deleted on GitHub without a merge", async () => {
    const repository = pushedStack("a", "b");
    repository.git("push", "--quiet", "origin", "--delete", "a");
    const branches = repository.branches();
    const failure = await failureIn(repository, { b: openPullRequest("a", 2, "b") });
    expect(failure).toBe(deletedFailure("a: no pull request from it merged"));
    expect(repository.log()).toEqual(["a [a]", "b [b]"]);
    expect(repository.branches()).toEqual(branches);
  });

  it("stops where a branch merged, and its change was edited since", async () => {
    const repository = pushedStack("a", "b");
    squashMergeOnGitHub(repository, "a", { above: ["b"] });
    repository.jj("edit", "a");
    repository.write("a.txt", "a, edited\n");
    const failure = await failureIn(repository, { b: openPullRequest("main", 2, "b") });
    expect(failure).toBe(
      deletedFailure("a: its pushed commit merged, and the change was edited since"),
    );
  });

  it("stops where a branch merged with a commit added on GitHub", async () => {
    const repository = pushedStack("a", "b");
    addCommitOnGitHub(repository, "a");
    squashMergeOnGitHub(repository, "a", { above: ["b"] });
    const failure = await failureIn(repository, { b: openPullRequest("main", 2, "b") });
    expect(failure).toBe(
      deletedFailure("a: a pull request from it merged, but not the commit pushed for this change"),
    );
    expect(repository.log()).toEqual(["a [a]", "b [b]"]);
  });

  it("leaves alone the changes above the one named", async () => {
    const repository = pushedStack("a", "b");
    repository.git("push", "--quiet", "origin", "--delete", "b");
    repository.jj("edit", "a");
    repository.write("a.txt", "a, edited\n");
    const { run } = submitIn(repository, { a: openPullRequest("main", 1, "a") }, "a");
    await run;
    repository.git("fetch", "--quiet");
    expect(repository.git("show", "origin/a:a.txt")).toBe("a, edited\n");
  });

  it("rebases onto the trunk the changes left without a bookmark once the stack merged", async () => {
    const repository = pushedStack("a", "b");
    repository.write("c.txt", "c\n");
    repository.jj("describe", "-m", "c");
    squashMergeOnGitHub(repository, "b", { below: ["a"] });
    const { run } = submitIn(repository, {}, "b");
    await run;
    expect(repository.log()).toEqual(["c []"]);
    const below = repository.jj(
      "log",
      "--no-graph",
      "-r",
      'description(exact:"c\n")-',
      "-T",
      "description",
    );
    expect(below).toBe("b (#1)\n");
  });

  it("forgets the bookmarks above the one named that merged too", async () => {
    const repository = pushedStack("a", "b", "c");
    squashMergeOnGitHub(repository, "c", { below: ["a", "b"] });
    const { run } = submitIn(repository, {}, "b");
    await run;
    expect(repository.log()).toEqual([]);
    expect(repository.jj("bookmark", "list", "--all-remotes", "c")).toBe("");
  });

  it("submits nothing where the change named merged", async () => {
    const repository = pushedStack("a", "b");
    squashMergeOnGitHub(repository, "b", { below: ["a"] });
    const { calls, run } = submitIn(repository, {}, "b");
    await run;
    expect(repository.log()).toEqual([]);
    expect(calls).toEqual([]);
    expect(repository.jj("log", "--no-graph", "-r", "@- & trunk()", "-T", "description")).toBe(
      "b (#1)\n",
    );
  });
});
