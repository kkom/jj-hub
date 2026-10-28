import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";

import { Effect, Layer } from "effect";

import { IGNORE_CLAUDE_CODE_FOOTER, readSetting, type Setting } from "./settings";
import { environment } from "./testing/environment";
import { gitClone, runIn } from "./testing/git-clone";
import { removeScratchRepositories, scratchRepository } from "./testing/scratch-repository";

afterAll(removeScratchRepositories);

const mode: Setting<"fast" | "slow"> = {
  choices: [
    { description: "Goes fast.", value: "fast" },
    { description: "Goes slow.", value: "slow" },
  ],
  default: { description: "slow", value: Effect.succeed("slow") },
  description: "How fast it goes.",
  key: "jj-octo.mode",
};

/** A clone whose jj config holds `config`, and reads settings with `env` as the environment. */
const reader = (config: string, env: Readonly<Record<string, string>> = {}) => {
  const clone = gitClone(scratchRepository());
  writeFileSync(clone.jjConfigFile, config);
  return <A extends boolean | string>(setting: Setting<A>) =>
    runIn(
      Layer.merge(clone.layer, environment(env)),
      readSetting(setting).pipe(
        Effect.map((value) => ({ value })),
        Effect.catch(({ message }) => Effect.succeed({ message })),
      ),
    );
};

describe("readSetting", () => {
  it("reads a choice, the default where the key has none, and fails on any other value", async () => {
    const set = reader('[jj-octo]\nmode = "fast"\nignore-claude-code-footer = "yes"\n');
    const unset = reader("");
    expect([
      await set(mode),
      await unset(mode),
      await set(IGNORE_CLAUDE_CODE_FOOTER),
    ]).toStrictEqual([
      { value: "fast" },
      { value: "slow" },
      { message: 'jj-octo.ignore-claude-code-footer is "yes"; set it to true or false' },
    ]);
  });

  it("reads a choice of another type as a value it doesn't know", async () => {
    const read = reader("[jj-octo]\nmode = true\n");
    expect(await read(mode)).toStrictEqual({
      message: "jj-octo.mode is true; set it to fast or slow",
    });
  });

  it("reads a default that depends on the environment", async () => {
    const inCloudSession = reader("", { CLAUDE_CODE_REMOTE: "true" });
    const elsewhere = reader("");
    const overridden = reader("[jj-octo]\nignore-claude-code-footer = false\n", {
      CLAUDE_CODE_REMOTE: "true",
    });
    expect([
      await inCloudSession(IGNORE_CLAUDE_CODE_FOOTER),
      await elsewhere(IGNORE_CLAUDE_CODE_FOOTER),
      await overridden(IGNORE_CLAUDE_CODE_FOOTER),
    ]).toStrictEqual([{ value: true }, { value: false }, { value: false }]);
  });
});
