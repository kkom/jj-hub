import { afterAll, beforeEach, describe, expect, it } from "bun:test";

import { Effect, Option } from "effect";

import {
  addCommitOnGitHub,
  moveTrunkOnGitHub,
  rebaseOnGitHub,
  rewriteElsewhere,
  squashMergeOnGitHub,
} from "../../testing/branch-changes";
import { fakeGitHub, inRepository } from "../../testing/fake-github";
import {
  pushedStack,
  removeScratchRepositories,
  type ScratchRepository,
} from "../../testing/scratch-repository";
import { stackChanges } from "./stack/changes";
import { sync } from "./sync";

afterAll(removeScratchRepositories);

// GitHub reports the pull requests `squashMergeOnGitHub` merged.
const syncing = (repository: ScratchRepository) =>
  sync().pipe(
    inRepository(
      repository,
      fakeGitHub({}, Option.none(), { mergedHeads: repository.mergedHeads }),
    ),
  );

const syncIn = (repository: ScratchRepository): Promise<void> =>
  Effect.runPromise(syncing(repository));

// Rebases `a` onto a moved trunk on GitHub, and `b` onto the new `a`, with `b` edited locally.
const rebaseBoth = (repository: ScratchRepository): void => {
  repository.jj("edit", "b");
  repository.write("b-local.txt", "b, locally\n");
  repository.jj("new");
  repository.git("fetch", "--quiet");
  const pushedA = repository.git("rev-parse", "origin/a").trim();
  rebaseOnGitHub(repository, "a");
  repository.git("checkout", "--quiet", "-B", "b", "origin/b");
  repository.git("rebase", "--quiet", "--onto", "a", pushedA, "b");
  repository.git("push", "--quiet", "--force", "origin", "b");
};

// Changes a file of the change `a`, which the working copy sits two changes above.
const editLocally = (repository: ScratchRepository): void => {
  repository.jj("edit", "a");
  repository.write("local.txt", "local\n");
  repository.jj("new", "b");
};

describe("sync", () => {
  let repository = pushedStack("a", "b");

  beforeEach(() => {
    repository = pushedStack("a", "b");
  });

  it("rebases every stack onto the moved trunk, and pushes nothing", async () => {
    repository.jj("new", "main", "-m", "c");
    repository.jj("bookmark", "create", "c", "-r", "@");
    const pushed = repository.branches();
    moveTrunkOnGitHub(repository);
    await syncIn(repository);
    expect(repository.files("b")).toContain("trunk.txt");
    expect(repository.files("c")).toContain("trunk.txt");
    expect(repository.branches()).toEqual({ ...pushed, main: repository.branches()["main"] ?? "" });
  });

  it("leaves a stack that conflicts with the moved trunk where it was", async () => {
    repository.jj("new", "main", "-m", "c");
    repository.jj("bookmark", "create", "c", "-r", "@");
    repository.write("trunk.txt", "c's own\n");
    repository.jj("new", "b");
    moveTrunkOnGitHub(repository);
    await syncIn(repository);
    expect(repository.jj("log", "--no-graph", "-r", "conflicts()", "-T", "change_id")).toBe("");
    expect(repository.jj("log", "--no-graph", "-r", "c-", "-T", "description")).toBe("base\n");
    expect(repository.files("b")).toContain("trunk.txt");
  });

  // GitHub can delete a merged branch after the fetch, which leaves its bookmark on the trunk.
  it("abandons a merged change and forgets its bookmark, with the branch still on GitHub", async () => {
    squashMergeOnGitHub(repository, "a", { deleted: false });
    await syncIn(repository);
    expect(repository.log()).toEqual(["b [b]"]);
    expect(repository.jj("bookmark", "list", "--all-remotes", "a")).toBe("");
  });

  // GitHub merges a stack as one commit, on a trunk that moved since the stack was pushed. Rebased
  // onto the trunk, `a` would conflict with `b`'s edit of the same file, rather than come out
  // empty. The branches are still on GitHub, so the fetch doesn't drop the changes either.
  it("abandons every change whose pull request merged, and rebases the rest onto the trunk", async () => {
    repository.jj("edit", "b");
    repository.write("a.txt", "a, edited by b\n");
    repository.jj("new", "b", "-m", "c");
    repository.write("c.txt", "c\n");
    repository.jj("git", "push", "--bookmark", "b");
    moveTrunkOnGitHub(repository);
    squashMergeOnGitHub(repository, "b", { below: ["a"], deleted: false });
    await syncIn(repository);
    expect(repository.log()).toEqual(["c []"]);
    expect(repository.jj("log", "--no-graph", "-r", "conflicts()", "-T", "description")).toBe("");
    expect(repository.files("@")).toEqual(["a.txt", "b.txt", "base.txt", "c.txt", "trunk.txt"]);
    expect(repository.jj("bookmark", "list", "--all-remotes", "a", "b")).toBe("");
  });

  it("keeps a change edited after its pull request merged", async () => {
    squashMergeOnGitHub(repository, "a", { deleted: false });
    editLocally(repository);
    await syncIn(repository);
    expect(repository.log()).toEqual(["a [a]", "b [b]"]);
    expect(repository.files("a")).toEqual(["a.txt", "base.txt", "local.txt"]);
  });

  it("takes the rest of a stack as GitHub rebased it after a merge", async () => {
    squashMergeOnGitHub(repository, "a", { above: ["b"] });
    await syncIn(repository);
    expect(repository.log()).toEqual(["b [b]"]);
    expect(repository.files("b")).toEqual(["a.txt", "b.txt", "base.txt"]);
  });

  // The fetch drops the old commits of a branch GitHub rewrote, which takes whatever was on them
  // off the stack.
  describe("after GitHub rebased the rest of a stack", () => {
    it("keeps the working copy on top of the stack", async () => {
      squashMergeOnGitHub(repository, "a", { above: ["b"] });
      await syncIn(repository);
      expect(repository.jj("log", "--no-graph", "-r", "@-", "-T", "bookmarks")).toBe("b");
    });

    it("keeps editing the change the working copy was", async () => {
      repository.jj("edit", "b");
      squashMergeOnGitHub(repository, "a", { above: ["b"] });
      await syncIn(repository);
      expect(repository.jj("log", "--no-graph", "-r", "@", "-T", "bookmarks")).toBe("b");
    });

    it("keeps a change that isn't pushed on top of the stack", async () => {
      repository.write("c.txt", "c\n");
      repository.jj("describe", "-m", "c");
      squashMergeOnGitHub(repository, "a", { above: ["b"] });
      await syncIn(repository);
      expect(repository.log()).toEqual(["b [b]", "c []"]);
    });
  });

  describe("when a branch changed on GitHub", () => {
    it("folds a commit GitHub added into an untouched local change", async () => {
      addCommitOnGitHub(repository, "a");
      await syncIn(repository);
      expect(repository.log()).toEqual(["a [a]", "b [b]"]);
      expect(repository.files("a")).toEqual(["a.txt", "base.txt", "suggestion.txt"]);
    });

    it("folds a commit GitHub added into a local change that was edited too", async () => {
      editLocally(repository);
      addCommitOnGitHub(repository, "a");
      await syncIn(repository);
      expect(repository.log()).toEqual(["a [a]", "b [b]"]);
      expect(repository.files("a")).toEqual(["a.txt", "base.txt", "local.txt", "suggestion.txt"]);
    });

    it("folds commits GitHub added to two branches of one stack", async () => {
      addCommitOnGitHub(repository, "a", "for-a.txt");
      addCommitOnGitHub(repository, "b", "for-b.txt");
      await syncIn(repository);
      expect(repository.log()).toEqual(["a [a]", "b [b]"]);
      expect(repository.files("a")).toEqual(["a.txt", "base.txt", "for-a.txt"]);
      expect(repository.files("b")).toEqual([
        "a.txt",
        "b.txt",
        "base.txt",
        "for-a.txt",
        "for-b.txt",
      ]);
    });

    it("takes a branch GitHub rebased where the local change is untouched", async () => {
      rebaseOnGitHub(repository, "a");
      await syncIn(repository);
      expect(repository.log()).toEqual(["a [a]", "b [b]"]);
      expect(repository.files("b")).toEqual(["a.txt", "b.txt", "base.txt", "trunk.txt"]);
    });

    // GitHub's copy of `b` sits on its copy of `a`, which must not go with the copies of `b`.
    describe("where GitHub rebased two branches", () => {
      it("keeps the bookmark below", async () => {
        rebaseBoth(repository);
        await syncIn(repository);
        expect(repository.log()).toEqual(["a [a]", "b [b]"]);
        expect(repository.files("b")).toEqual([
          "a.txt",
          "b-local.txt",
          "b.txt",
          "base.txt",
          "trunk.txt",
        ]);
      });

      it("leaves no copy of GitHub's commits where both were edited locally", async () => {
        repository.jj("edit", "a");
        repository.write("a-local.txt", "a, locally\n");
        rebaseBoth(repository);
        await syncIn(repository);
        expect(repository.log()).toEqual(["a [a]", "b [b]"]);
      });
    });

    it("keeps an edited local change where GitHub only rebased the branch", async () => {
      editLocally(repository);
      rebaseOnGitHub(repository, "a");
      await syncIn(repository);
      expect(repository.log()).toEqual(["a [a]", "b [b]"]);
      expect(repository.files("a")).toEqual(["a.txt", "base.txt", "local.txt", "trunk.txt"]);
    });

    // Another checkout's commits keep the ids of the local changes, so a change that isn't
    // combined has two commits with one id while its stack is rebased. A sync rebases a stack
    // and pushes nothing, so the local changes differ from the pushed ones without being edited.
    it("fails after rebasing where another checkout rewrote changes a sync had rebased", async () => {
      moveTrunkOnGitHub(repository);
      await syncIn(repository);
      rewriteElsewhere(repository, "a", "b");
      moveTrunkOnGitHub(repository, "later.txt");
      const failure = await Effect.runPromise(Effect.flip(syncing(repository)));
      expect(failure.message).toContain("weren't combined:\nb\na\n");
      expect(repository.jj("log", "--no-graph", "-r", "conflicts()", "-T", "change_id")).toBe("");
      expect(repository.files("@")).toEqual([
        "a.txt",
        "b.txt",
        "base.txt",
        "later.txt",
        "trunk.txt",
      ]);
    });

    it("fails after rebasing where both sides changed and GitHub rewrote the branch", async () => {
      editLocally(repository);
      rebaseOnGitHub(repository, "a", { extra: true });
      const failure = await Effect.runPromise(Effect.flip(syncing(repository)));
      expect(failure.message).toContain("weren't combined:\na\n");
      expect(repository.files("b")).toContain("trunk.txt");
      const check = await Effect.runPromise(
        Effect.flip(stackChanges("@")).pipe(Effect.provide(repository.layer)),
      );
      expect(check.message).toContain("point at two changes");
    });
  });
});
