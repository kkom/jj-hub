import { afterAll, describe, expect, it } from "bun:test";

import { Effect, Option } from "effect";

import { moveTrunkOnGitHub, squashMergeOnGitHub } from "../../testing/branch-changes";
import { fakeGitHub, inRepository, openPullRequest, stackOf } from "../../testing/fake-github";
import {
  pushedStack,
  removeScratchRepositories,
  type ScratchRepository,
} from "../../testing/scratch-repository";
import { merge } from "./merge";

afterAll(removeScratchRepositories);

const open = { a: openPullRequest("main", 1, "a"), b: openPullRequest("a", 2, "b") };

// GitHub reports the pull requests `squashMergeOnGitHub` merged, and merges as `onMerge` says.
const mergingIn = (repository: ScratchRepository, onMerge: () => void) => ({
  onMerge,
  pullRequestsFrom: repository.pullRequestsFrom,
});

const mergeIn = (
  repository: ScratchRepository,
  github: ReturnType<typeof fakeGitHub>,
  revision: string,
) => merge(revision).pipe(inRepository(repository, github));

describe("merge", () => {
  it("merges a stacked pull request through its stack, then syncs and republishes the rest", async () => {
    const repository = pushedStack("a", "b");
    const github = fakeGitHub(
      open,
      stackOf(1, 2),
      mergingIn(repository, () => {
        squashMergeOnGitHub(repository, "a", { above: ["b"] });
      }),
    );
    await Effect.runPromise(mergeIn(repository, github, "a"));
    expect(github.calls[0]).toBe("merge the stack up to #1");
    expect(repository.log()).toEqual(["b [b]"]);
    expect(repository.branches()["b"]).toBe(
      repository.jj("log", "--no-graph", "-r", "b", "-T", "commit_id"),
    );
  });

  // Rebased onto the trunk, the first merged change would conflict with the second's edit of the
  // same file, rather than coming out empty. GitHub may delete the merged branches only after the
  // fetch, so the fetch can't be relied on to drop them either.
  it("drops every merged change, where a later one edited what an earlier one wrote", async () => {
    const repository = pushedStack("a", "b", "c");
    repository.jj("edit", "b");
    repository.write("a.txt", "a, edited by b\n");
    repository.jj("new", "c");
    repository.jj("git", "push", "--bookmark", "b", "--bookmark", "c");
    const github = fakeGitHub(
      { ...open, c: openPullRequest("b", 3, "c") },
      stackOf(1, 2, 3),
      mergingIn(repository, () => {
        squashMergeOnGitHub(repository, "a", { above: ["b", "c"], deleted: false });
        squashMergeOnGitHub(repository, "b", { above: ["c"], deleted: false });
      }),
    );
    await Effect.runPromise(mergeIn(repository, github, "b"));
    expect(repository.log()).toEqual(["c [c]"]);
    expect(repository.jj("log", "--no-graph", "-r", "conflicts()", "-T", "description")).toBe("");
  });

  // The stack merges as one commit, on a trunk that moved since the stack was pushed, and with an
  // unpushed change above it. Rebased onto the trunk, `a` would conflict with `b`'s edit.
  it("drops the merged changes of a stack merged as one commit, and rebases the change above", async () => {
    const repository = pushedStack("a", "b");
    repository.jj("edit", "b");
    repository.write("a.txt", "a, edited by b\n");
    repository.jj("new", "b", "-m", "c");
    repository.write("c.txt", "c\n");
    repository.jj("git", "push", "--bookmark", "b");
    const github = fakeGitHub(
      open,
      stackOf(1, 2),
      mergingIn(repository, () => {
        moveTrunkOnGitHub(repository);
        squashMergeOnGitHub(repository, "b", { below: ["a"], deleted: false });
      }),
    );
    await Effect.runPromise(mergeIn(repository, github, "b"));
    expect(repository.log()).toEqual(["c []"]);
    expect(repository.jj("log", "--no-graph", "-r", "conflicts()", "-T", "description")).toBe("");
    expect(repository.jj("log", "--no-graph", "-r", "@-", "-T", "description")).toBe("b (#1)\n");
    expect(repository.jj("bookmark", "list", "--all-remotes", "a", "b")).toBe("");
  });

  it("merges a pull request outside a stack alone", async () => {
    const repository = pushedStack("a", "b");
    const github = fakeGitHub(
      open,
      Option.none(),
      mergingIn(repository, () => {
        squashMergeOnGitHub(repository, "a");
      }),
    );
    await Effect.runPromise(mergeIn(repository, github, "a"));
    expect(github.calls[0]).toBe("merge #1");
    expect(repository.log()).toEqual(["b [b]"]);
  });

  it("rebases the rest of the stack even where it conflicts with the trunk", async () => {
    const repository = pushedStack("a", "b");
    const github = fakeGitHub(
      open,
      Option.none(),
      mergingIn(repository, () => {
        squashMergeOnGitHub(repository, "a");
        repository.writeOnGitHub("b.txt", "somebody else's\n");
        repository.git("add", ".");
        repository.git("commit", "--quiet", "-m", "another pull request");
        repository.git("push", "--quiet", "origin", "main");
      }),
    );
    const failure = await Effect.runPromise(Effect.flip(mergeIn(repository, github, "a")));
    expect(failure.message).toContain("resolve the conflicts first");
    expect(repository.log()).toEqual(["b [b]"]);
    expect(repository.jj("log", "--no-graph", "-r", "conflicts()", "-T", "description")).toBe(
      "b\n",
    );
  });

  it("merges from the change below an empty working copy by default", async () => {
    const repository = pushedStack("a", "b");
    const github = fakeGitHub(
      open,
      stackOf(1, 2),
      mergingIn(repository, () => {
        squashMergeOnGitHub(repository, "a", { deleted: false });
        squashMergeOnGitHub(repository, "b", { deleted: false });
      }),
    );
    await Effect.runPromise(mergeIn(repository, github, "@"));
    expect(github.calls).toEqual(["merge the stack up to #2"]);
    expect(repository.log()).toEqual([]);
  });

  it("merges nothing outside a GitHub stack when the base isn't the trunk", async () => {
    const repository = pushedStack("a", "b");
    const github = fakeGitHub(open, Option.none());
    const failure = await Effect.runPromise(Effect.flip(mergeIn(repository, github, "b")));
    expect(failure.message).toContain("#2 isn't in a GitHub stack, and its base is a");
    expect(github.calls).toEqual([]);
  });

  it("merges nothing while a change has edits that aren't pushed", async () => {
    const repository = pushedStack("a", "b");
    repository.jj("describe", "-r", "a", "-m", "a, reworded");
    const github = fakeGitHub(open, stackOf(1, 2));
    const failure = await Effect.runPromise(Effect.flip(mergeIn(repository, github, "b")));
    expect(failure.message).toContain("these changes aren't pushed: a, b");
    expect(github.calls).toEqual([]);
  });

  it("merges nothing for a change with no bookmark", async () => {
    const repository = pushedStack("a", "b");
    repository.jj("describe", "-m", "c");
    const github = fakeGitHub(open, Option.none());
    const failure = await Effect.runPromise(Effect.flip(mergeIn(repository, github, "@")));
    expect(failure.message).toContain("needs a bookmark");
    expect(github.calls).toEqual([]);
  });

  it("merges nothing for a bookmark with no open pull request", async () => {
    const repository = pushedStack("a", "b");
    const github = fakeGitHub({}, Option.none());
    const failure = await Effect.runPromise(Effect.flip(mergeIn(repository, github, "b")));
    expect(failure.message).toContain("no open pull request for b");
    expect(github.calls).toEqual([]);
  });
});
