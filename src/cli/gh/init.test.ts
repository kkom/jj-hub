import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

import { Effect, type Layer } from "effect";

import type { Git } from "../../clients/git";
import type { Jj } from "../../clients/jj";
import { gitClone, runIn } from "../../testing/git-clone";
import {
  removeScratchRepositories,
  type ScratchRepository,
  scratchDirectory,
  scratchRepository,
} from "../../testing/scratch-repository";
import { init } from "./init";
import { NotSetUp } from "./setup";
import { checkTrunk } from "./stack/trunk";

afterAll(removeScratchRepositories);

const initIn = (layer: Layer.Layer<Git | Jj>): Promise<void> => runIn(layer, init);

/** Pushes a `develop` branch, and makes it `origin`'s default branch. */
const defaultToDevelop = (repository: ScratchRepository): void => {
  repository.jj("new", "main", "-m", "develop");
  repository.write("develop.txt", "develop\n");
  repository.jj("bookmark", "create", "develop", "-r", "@");
  repository.jj("git", "push", "--bookmark", "develop");
  const origin = repository.git("remote", "get-url", "origin").trim();
  repository.git("--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/develop");
};

describe("init", () => {
  it("colocates a git clone, and copies git's identity into jj", async () => {
    const clone = gitClone(scratchRepository());
    await initIn(clone.layer);
    expect(clone.jj("config", "get", "user.name")).toBe("Cloner\n");
    expect(clone.jj("config", "get", "user.email")).toBe("cloner@example.com\n");
    expect(clone.jj("log", "--no-graph", "-r", "@", "-T", "author.email()")).toBe(
      "cloner@example.com",
    );
    expect(clone.jj("config", "get", "aliases.gh")).toContain("jj-octo");
  });

  it("copies a name that isn't a bare TOML value, such as a bot's", async () => {
    const clone = gitClone(scratchRepository(), "renovate[bot]");
    await initIn(clone.layer);
    expect(clone.jj("config", "get", "user.name")).toBe("renovate[bot]\n");
  });

  it("sets up the rest, and then fails on the part of an identity that neither jj nor git has", async () => {
    const clone = gitClone(scratchRepository());
    clone.git("config", "--unset", "user.email");
    expect(await runIn(clone.layer, Effect.flip(init))).toStrictEqual(
      new NotSetUp({
        message: "neither jj nor git has user.email; set it with `jj config set --user user.email`",
      }),
    );
    expect([
      clone.jj("config", "get", "user.name"),
      clone.jj("config", "list", "--repo", "aliases.gh"),
    ]).toStrictEqual(["Cloner\n", 'aliases.gh = ["util","exec","--","jj-octo"]\n']);
  });

  it("sets up the rest where origin can't be read, and then fails with git's error", async () => {
    const clone = gitClone(scratchRepository());
    clone.git("remote", "set-url", "origin", "/nonexistent");
    expect(await runIn(clone.layer, Effect.flip(init))).toStrictEqual(
      new NotSetUp({
        message: [
          "git ls-remote --symref origin HEAD failed: fatal: '/nonexistent' does not appear to be a git repository",
          "fatal: Could not read from remote repository.",
          "",
          "Please make sure you have the correct access rights",
          "and the repository exists.",
        ].join("\n"),
      }),
    );
    expect(clone.jj("config", "list", "--repo", "aliases.gh")).toBe(
      'aliases.gh = ["util","exec","--","jj-octo"]\n',
    );
  });

  it("fails where a config that overrides the repository's undoes a fix", async () => {
    const clone = gitClone(scratchRepository());
    await initIn(clone.layer);
    clone.jj("config", "set", "--workspace", 'revset-aliases."trunk()"', "root()");
    expect(await runIn(clone.layer, Effect.flip(init))).toStrictEqual(
      new NotSetUp({
        message:
          "trunk() isn't main@origin, GitHub's default branch, fetched and tracked, though init set it up",
      }),
    );
  });

  it("leaves a git worktree as it is", async () => {
    const clone = gitClone(scratchRepository());
    const worktree = path.join(scratchDirectory("worktree-"), "checkout");
    clone.git("worktree", "add", "--detach", worktree);
    expect(await runIn(clone.layerAt(worktree), Effect.flip(init))).toStrictEqual(
      new NotSetUp({
        message:
          "this is a git worktree, where jj would make a second repository; run `jj workspace add` in the main checkout instead",
      }),
    );
    expect(existsSync(path.join(worktree, ".jj"))).toBe(false);
  });

  it("gives an author to the working copy of a repository colocated without one", async () => {
    const clone = gitClone(scratchRepository());
    clone.jj("git", "init", "--colocate");
    clone.jj("commit", "-m", "work");
    await initIn(clone.layer);
    expect(
      clone.jj("log", "--no-graph", "-r", "@ | @-", "-T", String.raw`author.email() ++ "\n"`),
    ).toBe("cloner@example.com\ncloner@example.com\n");
  });

  it("makes trunk() the default branch, fetching and tracking it", async () => {
    const repository = scratchRepository();
    const clone = gitClone(repository);
    // Jj makes `trunk()` the default branch it finds when it colocates.
    clone.jj("git", "init", "--colocate");
    defaultToDevelop(repository);
    await initIn(clone.layer);
    expect(clone.jj("config", "get", 'revset-aliases."trunk()"')).toBe('"develop"@origin\n');
    expect(clone.jj("bookmark", "list", "--tracked", "-T", String.raw`name ++ "\n"`)).toContain(
      "develop",
    );
  });

  it("makes trunk() a new default branch on the same commit as the old one", async () => {
    const repository = scratchRepository();
    const clone = gitClone(repository);
    clone.jj("git", "init", "--colocate");
    repository.jj("bookmark", "create", "develop", "-r", "main");
    repository.jj("git", "push", "--bookmark", "develop");
    const origin = repository.git("remote", "get-url", "origin").trim();
    repository.git("--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/develop");
    await initIn(clone.layer);
    expect(clone.jj("config", "get", 'revset-aliases."trunk()"')).toBe('"develop"@origin\n');
  });

  it("changes nothing when run again", async () => {
    const clone = gitClone(scratchRepository());
    await initIn(clone.layer);
    const operations = clone.jj("operation", "log", "--no-graph", "-T", String.raw`id ++ "\n"`);
    await initIn(clone.layer);
    expect(clone.jj("operation", "log", "--no-graph", "-T", String.raw`id ++ "\n"`)).toBe(
      operations,
    );
  });
});

describe("checkTrunk", () => {
  it("fails where trunk() isn't the default branch, until init sets it", async () => {
    const repository = scratchRepository();
    defaultToDevelop(repository);
    const check = checkTrunk("develop").pipe(Effect.provide(repository.layer));
    const failure = await Effect.runPromise(Effect.flip(check));
    expect(failure.message).toBe(
      "trunk() isn't develop@origin, GitHub's default branch; run `jj-octo init`",
    );
    await initIn(repository.layer);
    await Effect.runPromise(check);
  });
});
