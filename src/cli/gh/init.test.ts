import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Effect, type Layer } from "effect";

import manifest from "../../../package.json" with { type: "json" };
import type { Git } from "../../clients/git";
import type { Jj } from "../../clients/jj";
import { gitClone, runIn } from "../../testing/git-clone";
import {
  removeScratchRepositories,
  type ScratchRepository,
  scratchDirectory,
  scratchRepository,
} from "../../testing/scratch-repository";
import { problems } from "./doctor";
import { init, setUpOnUpgrade } from "./init";
import { NotSetUp, SET_UP_VERSION } from "./setup";
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

  it("keeps a `jj gh` alias that runs another build", async () => {
    const clone = gitClone(scratchRepository());
    clone.jj("git", "init", "--colocate");
    clone.jj("config", "set", "--repo", "aliases.gh", '["util", "exec", "--", "bun", "main.ts"]');
    await initIn(clone.layer);
    expect(clone.jj("config", "get", "aliases.gh")).toBe(
      '["util", "exec", "--", "bun", "main.ts"]\n',
    );
  });

  it("sets the repository's `jj gh` alias where only the user's config has one", async () => {
    const clone = gitClone(scratchRepository());
    writeFileSync(clone.jjConfigFile, 'aliases.gh = ["gh"]\n');
    await initIn(clone.layer);
    expect(clone.jj("config", "list", "--repo", "aliases.gh")).toBe(
      'aliases.gh = ["util","exec","--","jj-octo"]\n',
    );
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

type Clone = ReturnType<typeof gitClone>;

/** The version the clone's repository config records setting it up with, as jj lists it. */
const recorded = (clone: Clone): string => clone.jj("config", "list", "--repo", SET_UP_VERSION);

/** The repository's `jj gh` alias, as jj lists it. */
const alias = (clone: Clone): string => clone.jj("config", "list", "--repo", "aliases.gh");

const THIS_VERSION = `${SET_UP_VERSION} = "${manifest.version}"\n`;
const ALIAS = 'aliases.gh = ["util","exec","--","jj-octo"]\n';

/** A clone that init set up, with the version given recorded and the alias removed. */
const setUpBy = async (version: string): Promise<Clone> => {
  const clone = gitClone(scratchRepository());
  await initIn(clone.layer);
  clone.jj("config", "set", "--repo", SET_UP_VERSION, JSON.stringify(version));
  clone.jj("config", "unset", "--repo", "aliases.gh");
  return clone;
};

describe("the version that set the checkout up", () => {
  it("is recorded by init", async () => {
    const clone = gitClone(scratchRepository());
    await initIn(clone.layer);
    expect(recorded(clone)).toBe(THIS_VERSION);
  });

  it("sets up a checkout where no version is recorded", async () => {
    const clone = gitClone(scratchRepository());
    clone.jj("git", "init", "--colocate");
    await runIn(clone.layer, setUpOnUpgrade);
    expect([await runIn(clone.layer, problems), recorded(clone)]).toStrictEqual([[], THIS_VERSION]);
  });

  it("sets up a plain git clone", async () => {
    const clone = gitClone(scratchRepository());
    await runIn(clone.layer, setUpOnUpgrade);
    expect([await runIn(clone.layer, problems), recorded(clone)]).toStrictEqual([[], THIS_VERSION]);
  });

  it.each([
    { recorded: "0.0.1", setsUp: true, title: "sets it up where an older version is recorded" },
    { recorded: "dev", setsUp: true, title: "sets it up where what's recorded isn't a version" },
    {
      recorded: manifest.version,
      setsUp: false,
      title: "leaves it where this version is recorded",
    },
    { recorded: "99.0.0", setsUp: false, title: "leaves it where a newer version is recorded" },
  ])("$title", async ({ recorded: version, setsUp }) => {
    const clone = await setUpBy(version);
    await runIn(clone.layer, setUpOnUpgrade);
    expect([alias(clone), recorded(clone)]).toStrictEqual(
      setsUp ? [ALIAS, THIS_VERSION] : ["", `${SET_UP_VERSION} = ${JSON.stringify(version)}\n`],
    );
  });

  it("records this version, and leaves what's left to doctor, where init can't set the checkout up", async () => {
    const clone = gitClone(scratchRepository());
    clone.git("config", "--unset", "user.email");
    await runIn(clone.layer, setUpOnUpgrade);
    expect([await runIn(clone.layer, problems), recorded(clone)]).toStrictEqual([
      ["neither jj nor git has user.email; set it with `jj config set --user user.email`"],
      THIS_VERSION,
    ]);
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
