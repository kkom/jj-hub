import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

import { Effect } from "effect";

import { gitClone, runIn } from "../testing/git-clone";
import { removeScratchRepositories, scratchRepository } from "../testing/scratch-repository";
import { GitFailed, gitConfig } from "./git";

afterAll(removeScratchRepositories);

describe("gitConfig", () => {
  it("reads a key without a value as an empty string, and fails on a config git can't read", async () => {
    const clone = gitClone(scratchRepository());
    expect(await runIn(clone.layer, gitConfig(["jj-octo.no-such-key"]))).toBe("");
    const config = path.join(clone.git("rev-parse", "--absolute-git-dir").trim(), "config");
    appendFileSync(config, "[\n");
    const failure = await runIn(clone.layer, Effect.flip(gitConfig(["jj-octo.no-such-key"])));
    const badLine = readFileSync(config, "utf8").split("\n").length - 1;
    expect(failure).toStrictEqual(
      new GitFailed({
        exitCode: 128,
        message: `git config jj-octo.no-such-key failed: fatal: bad config line ${badLine} in file .git/config`,
      }),
    );
  });
});
