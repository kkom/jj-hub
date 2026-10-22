import { afterAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { Effect } from "effect";

import { gitClone, runIn } from "../../testing/git-clone";
import {
  removeScratchRepositories,
  scratchDirectory,
  scratchRepository,
} from "../../testing/scratch-repository";
import { problems } from "./doctor";
import { init } from "./init";
import { NotSetUp } from "./setup";

afterAll(removeScratchRepositories);

const INIT = "; run `jj-octo init`";

describe("problems", () => {
  it("finds what init sets up in a plain git clone, and nothing once init has", async () => {
    const clone = gitClone(scratchRepository());
    expect(await runIn(clone.layer, problems)).toStrictEqual([
      `this checkout isn't a jj repository colocated with git${INIT}`,
    ]);
    await runIn(clone.layer, init);
    expect(await runIn(clone.layer, problems)).toStrictEqual([]);
  });

  it("takes jj's own trunk() alias for the default branch", async () => {
    const clone = gitClone(scratchRepository());
    // Jj sets `trunk()` to `main@origin`, without the quotes init writes.
    clone.jj("git", "init", "--colocate");
    clone.jj("bookmark", "track", "main", "--remote", "origin");
    // The changes jj made without an identity count as part of the identity's problem.
    expect(await runIn(clone.layer, problems)).toStrictEqual([
      `jj has no user.name, which git has${INIT}`,
      `jj has no user.email, which git has${INIT}`,
      `\`jj gh\` isn't set up${INIT}`,
    ]);
  });

  it("finds only that a git worktree isn't a jj repository", async () => {
    const clone = gitClone(scratchRepository());
    const worktree = path.join(scratchDirectory("worktree-"), "checkout");
    clone.git("worktree", "add", "--detach", worktree);
    expect(await runIn(clone.layerAt(worktree), problems)).toStrictEqual([
      "this is a git worktree, where jj would make a second repository; run `jj workspace add` in the main checkout instead",
    ]);
  });

  it("tells to set an identity where neither jj nor git has one", async () => {
    const clone = gitClone(scratchRepository());
    clone.git("config", "--unset", "user.name");
    clone.git("config", "--unset", "user.email");
    const identity = [
      "neither jj nor git has user.name; set it with `jj config set --user user.name`",
      "neither jj nor git has user.email; set it with `jj config set --user user.email`",
    ];
    expect(await runIn(clone.layer, Effect.flip(init))).toStrictEqual(
      new NotSetUp({ message: identity.join("\n") }),
    );
    expect(await runIn(clone.layer, problems)).toStrictEqual(identity);
  });

  it("finds a trunk() that isn't the default branch", async () => {
    const clone = gitClone(scratchRepository());
    await runIn(clone.layer, init);
    clone.jj("config", "set", "--repo", 'revset-aliases."trunk()"', "root()");
    expect(await runIn(clone.layer, problems)).toStrictEqual([
      `trunk() isn't main@origin, GitHub's default branch, fetched and tracked${INIT}`,
    ]);
  });

  it("runs the other checks where origin can't be read", async () => {
    const clone = gitClone(scratchRepository());
    await runIn(clone.layer, init);
    clone.git("remote", "set-url", "origin", "/nonexistent");
    expect(await runIn(clone.layer, problems)).toStrictEqual([
      [
        "could not check: git ls-remote --symref origin HEAD failed: fatal: '/nonexistent' does not appear to be a git repository",
        "fatal: Could not read from remote repository.",
        "",
        "Please make sure you have the correct access rights",
        "and the repository exists.",
      ].join("\n"),
    ]);
  });
});
