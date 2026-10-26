import { afterAll, describe, expect, it } from "bun:test";

import { Effect, Option } from "effect";

import { fakeGitHub, openPullRequest, stackOf } from "../../../testing/fake-github";
import { removeScratchRepositories, scratchRepository } from "../../../testing/scratch-repository";
import { description, githubWith, pushed, submitIn } from "../../../testing/submit";

afterAll(removeScratchRepositories);

describe("submit", () => {
  it("pushes the bookmarks, opens the missing pull requests and registers a new stack", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b");
    const github = fakeGitHub({}, Option.none());
    await Effect.runPromise(submitIn(repository, github));
    expect(Object.keys(repository.branches())).toEqual(["a", "b", "main"]);
    expect(github.calls).toEqual([
      "open a on main as a draft",
      "open b on a as a draft",
      "create stack 99,99",
    ]);
  });

  it("opens the missing pull requests ready for review when not drafts", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b");
    const github = fakeGitHub({}, Option.none());
    await Effect.runPromise(submitIn(repository, github, { draft: false }));
    expect(github.calls).toEqual(["open a on main", "open b on a", "create stack 99,99"]);
  });

  it("changes nothing on GitHub for a stack already in order", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b");
    const github = fakeGitHub(
      { a: openPullRequest("main", 1, "a"), b: openPullRequest("a", 2, "b") },
      stackOf(1, 2),
    );
    await Effect.runPromise(submitIn(repository, github));
    expect(github.calls).toEqual([]);
  });

  it("appends a pull request opened on top", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b", "c");
    const github = fakeGitHub(
      { a: openPullRequest("main", 1, "a"), b: openPullRequest("a", 2, "b") },
      stackOf(1, 2),
    );
    await Effect.runPromise(submitIn(repository, github));
    expect(github.calls).toEqual(["open c on b as a draft", "add 99 to #7"]);
  });

  // GitHub rejects a base change on a pull request in a stack, and closes a pull request whose
  // head becomes reachable from its base. So the stack goes first, the moved pull request is parked
  // on the trunk before the push, and it gets its new base and a new stack after.
  it("reorders by dissolving, parking on the trunk, pushing, then rebasing and registering", async () => {
    const repository = scratchRepository();
    repository.stack("a", "c", "b");
    const github = fakeGitHub(
      {
        a: openPullRequest("main", 1, "a"),
        b: openPullRequest("a", 2, "b"),
        c: openPullRequest("b", 3, "c"),
      },
      stackOf(1, 2, 3),
    );
    await Effect.runPromise(submitIn(repository, github));
    expect(github.calls).toEqual([
      "unstack #7",
      "base #3 → main",
      "base #2 → main",
      "base #3 → a",
      "base #2 → c",
      "create stack 1,3,2",
    ]);
  });

  it("submits a named change and the ones below it, from a working copy elsewhere", async () => {
    const repository = scratchRepository();
    repository.stack("a", "b", "c");
    repository.jj("new", "main", "-m", "d");
    const github = fakeGitHub({}, Option.none());
    await Effect.runPromise(submitIn(repository, github, { revision: "b" }));
    expect(Object.keys(repository.branches())).toEqual(["a", "b", "main"]);
    expect(github.calls).toEqual([
      "open a on main as a draft",
      "open b on a as a draft",
      "create stack 99,99",
    ]);
  });

  describe("descriptions", () => {
    it("sends a description changed locally to the pull request", async () => {
      const repository = pushed();
      repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
      const github = githubWith("a", "first\n\nsecond");
      await Effect.runPromise(submitIn(repository, github));
      expect(github.calls).toEqual(["describe #1 as a better"]);
    });

    it("sends a description changed locally and pushed without submit", async () => {
      const repository = pushed();
      repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
      repository.jj("git", "push", "--bookmark", "a", "--bookmark", "b");
      const github = githubWith("a", "first\n\nsecond");
      await Effect.runPromise(submitIn(repository, github));
      expect(description(repository, "a")).toBe("a better\n\nfirst\n\nsecond");
      expect(github.calls).toEqual(["describe #1 as a better"]);
    });

    it("sends an upstack description pushed without submit, after taking a lower one from GitHub", async () => {
      const repository = pushed();
      repository.jj("describe", "-r", "b", "-m", "b better");
      repository.jj("git", "push", "--bookmark", "b");
      const github = githubWith("a", "first\n\nsecond, reworded");
      await Effect.runPromise(submitIn(repository, github));
      expect(description(repository, "a")).toBe("a\n\nfirst\n\nsecond, reworded");
      expect(description(repository, "b")).toBe("b better");
      expect(github.calls).toEqual(["describe #2 as b better"]);
    });

    it("sends a description changed again after a push without submit", async () => {
      const repository = pushed();
      repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
      repository.jj("git", "push", "--bookmark", "a", "--bookmark", "b");
      repository.jj("describe", "-r", "a", "-m", "a best\n\nfirst\n\nsecond");
      const github = githubWith("a", "first\n\nsecond");
      await Effect.runPromise(submitIn(repository, github));
      expect(github.calls).toEqual(["describe #1 as a best"]);
    });

    it("takes GitHub's edit where its text came from a change squashed into this one", async () => {
      const repository = pushed();
      repository.jj("new", "main", "-m", "a\n\nfirst\n\nsecond, reworded");
      repository.jj("squash", "--from", "@", "--into", "a", "--use-destination-message");
      const github = githubWith("a", "first\n\nsecond, reworded");
      await Effect.runPromise(submitIn(repository, github, { revision: "b" }));
      expect(description(repository, "a")).toBe("a\n\nfirst\n\nsecond, reworded");
      expect(github.calls).toEqual([]);
    });

    it("writes a description changed on GitHub into the change", async () => {
      const repository = pushed();
      const github = githubWith("a", "first\r\n\r\nsecond, reworded");
      await Effect.runPromise(submitIn(repository, github));
      expect(description(repository, "a")).toBe("a\n\nfirst\n\nsecond, reworded");
      expect(github.calls).toEqual([]);
    });

    it("writes the indent of a body's first line, set on GitHub, into the change", async () => {
      const repository = pushed();
      const github = githubWith("a", "    first\n\nsecond");
      await Effect.runPromise(submitIn(repository, github));
      expect(description(repository, "a")).toBe("a\n\n    first\n\nsecond");
      expect(github.calls).toEqual([]);
    });

    describe("with the Claude Code proxy's footer on GitHub", () => {
      const footer = "\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_";

      it("takes the footer into the change by default", async () => {
        const repository = pushed();
        const github = githubWith("a", `first\n\nsecond${footer}`);
        await Effect.runPromise(submitIn(repository, github));
        expect(description(repository, "a")).toBe(`a\n\nfirst\n\nsecond${footer}`);
        expect(github.calls).toEqual([]);
      });

      it("leaves the change alone when told to ignore the footer", async () => {
        const repository = pushed();
        repository.jj("config", "set", "--repo", "jj-octo.ignore-claude-code-footer", "true");
        const github = githubWith("a", `first\n\nsecond${footer}`);
        await Effect.runPromise(submitIn(repository, github));
        expect(description(repository, "a")).toBe("a\n\nfirst\n\nsecond");
        expect(github.calls).toEqual([]);
      });

      it("sends a description pushed without submit when told to ignore the footer", async () => {
        const repository = pushed();
        repository.jj("config", "set", "--repo", "jj-octo.ignore-claude-code-footer", "true");
        repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
        repository.jj("git", "push", "--bookmark", "a", "--bookmark", "b");
        const github = githubWith("a", `first\n\nsecond${footer}`);
        await Effect.runPromise(submitIn(repository, github));
        expect(github.calls).toEqual(["describe #1 as a better"]);
      });

      it("leaves the change alone by default in a Claude Code cloud session", async () => {
        const repository = pushed();
        const github = githubWith("a", `first\n\nsecond${footer}`);
        await Effect.runPromise(
          submitIn(repository, github, { env: { CLAUDE_CODE_REMOTE: "true" } }),
        );
        expect(description(repository, "a")).toBe("a\n\nfirst\n\nsecond");
        expect(github.calls).toEqual([]);
      });

      it("takes the footer into the change in a cloud session when told not to ignore it", async () => {
        const repository = pushed();
        repository.jj("config", "set", "--repo", "jj-octo.ignore-claude-code-footer", "false");
        const github = githubWith("a", `first\n\nsecond${footer}`);
        await Effect.runPromise(
          submitIn(repository, github, { env: { CLAUDE_CODE_REMOTE: "true" } }),
        );
        expect(description(repository, "a")).toBe(`a\n\nfirst\n\nsecond${footer}`);
        expect(github.calls).toEqual([]);
      });

      it("fails for a value of the setting other than true or false", async () => {
        const repository = pushed();
        repository.jj("config", "set", "--repo", "jj-octo.ignore-claude-code-footer", "yes");
        const github = githubWith("a", `first\n\nsecond${footer}`);
        const failure = await Effect.runPromise(Effect.flip(submitIn(repository, github)));
        expect(failure.message).toBe(
          'jj-octo.ignore-claude-code-footer is "yes"; set it to true or false',
        );
        expect(github.calls).toEqual([]);
      });
    });

    it("merges edits made to different lines on both sides", async () => {
      const repository = pushed();
      repository.jj("describe", "-r", "a", "-m", "a better\n\nfirst\n\nsecond");
      const github = githubWith("a", "first\n\nsecond, reworded");
      await Effect.runPromise(submitIn(repository, github));
      expect(description(repository, "a")).toBe("a better\n\nfirst\n\nsecond, reworded");
      expect(github.calls).toEqual(["describe #1 as a better"]);
    });

    it("stops before changing GitHub where both sides edited the same line", async () => {
      const repository = pushed();
      repository.jj("describe", "-r", "a", "-m", "a, locally\n\nfirst\n\nsecond");
      const github = githubWith("a, on GitHub", "first\n\nsecond");
      const branches = repository.branches();
      const failure = await Effect.runPromise(Effect.flip(submitIn(repository, github)));
      expect(failure.message).toContain("<<<<<<< local\na, locally\n");
      expect(failure.message).toContain("a, on GitHub\n>>>>>>> GitHub");
      expect(github.calls).toEqual([]);
      expect(repository.branches()).toEqual(branches);
    });

    it("sends the local description over a conflicting one when told to", async () => {
      const repository = pushed();
      repository.jj("describe", "-r", "a", "-m", "a, locally\n\nfirst\n\nsecond");
      const github = githubWith("a, on GitHub", "first\n\nsecond");
      await Effect.runPromise(submitIn(repository, github, { overwriteDescriptions: true }));
      expect(github.calls).toEqual(["describe #1 as a, locally"]);
    });
  });
});
