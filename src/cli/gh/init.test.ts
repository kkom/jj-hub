import { afterAll, describe, expect, it } from "bun:test";

import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

import type { Git } from "../../clients/git";
import type { Jj } from "../../clients/jj";
import { gitClone } from "../../testing/git-clone";
import {
  removeScratchRepositories,
  type ScratchRepository,
  scratchRepository,
} from "../../testing/scratch-repository";
import { init } from "./init";
import { checkTrunk } from "./stack/trunk";

afterAll(removeScratchRepositories);

const initIn = (layer: Layer.Layer<Git | Jj>): Promise<void> =>
  Effect.runPromise(init.pipe(Effect.provide(Layer.merge(layer, BunServices.layer))));

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
    expect(clone.jj("config", "get", 'revset-aliases."trunk()"')).toBe('"main"@origin\n');
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
    defaultToDevelop(repository);
    const clone = gitClone(repository);
    await initIn(clone.layer);
    expect(clone.jj("config", "get", 'revset-aliases."trunk()"')).toBe('"develop"@origin\n');
    expect(clone.jj("bookmark", "list", "--tracked", "-T", String.raw`name ++ "\n"`)).toContain(
      "develop",
    );
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
    expect(failure.message).toContain("run `jj gh init`");
    await initIn(repository.layer);
    await Effect.runPromise(check);
  });
});
