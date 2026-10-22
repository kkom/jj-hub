import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";

import { Effect } from "effect";

import { gitClone, runIn } from "../testing/git-clone";
import { removeScratchRepositories, scratchRepository } from "../testing/scratch-repository";
import { type Jj, JjFailed, jjConfig, jjFlag } from "./jj";

afterAll(removeScratchRepositories);

describe("jjConfig", () => {
  it("reads a key without a value as an empty string, and fails on a config jj can't read", async () => {
    const clone = gitClone(scratchRepository());
    expect(await runIn(clone.layer, jjConfig("jj-octo.no-such-key"))).toBe("");
    const config = clone.jjConfigFile;
    writeFileSync(config, "[");
    const failure = await runIn(clone.layer, Effect.flip(jjConfig("jj-octo.no-such-key")));
    expect(failure).toStrictEqual(
      new JjFailed({
        message: [
          "Config error: Configuration cannot be parsed as TOML document",
          "Caused by: TOML parse error at line 1, column 2",
          "  |",
          "1 | [",
          "  |  ^",
          "unquoted keys cannot be empty, expected letters, numbers, `-`, `_`",
          "",
          `Hint: Check the config file: ${config}`,
          "For help, see https://docs.jj-vcs.dev/latest/config/ or use `jj help -k config`.",
        ].join("\n"),
      }),
    );
  });

  it("reads strings and flags, and fails on a value of another type", async () => {
    const clone = gitClone(scratchRepository());
    writeFileSync(
      clone.jjConfigFile,
      '[jj-octo]\non = true\noff = false\nword = "true"\ntable = { a = "x" }\n',
    );
    const read = <A>(program: Effect.Effect<A, JjFailed, Jj>) =>
      runIn(
        clone.layer,
        program.pipe(
          Effect.map((value) => ({ value })),
          Effect.catch(({ message }) => Effect.succeed({ message })),
        ),
      );
    expect([
      await read(jjFlag("jj-octo.on")),
      await read(jjFlag("jj-octo.off")),
      await read(jjFlag("jj-octo.none")),
      await read(jjFlag("jj-octo.word")),
      await read(jjConfig("jj-octo.word")),
      await read(jjConfig("jj-octo.on")),
      await read(jjConfig("jj-octo.table")),
    ]).toStrictEqual([
      { value: true },
      { value: false },
      { value: false },
      { message: 'jj-octo.word is "true"; set it to true or false' },
      { value: "true" },
      { message: "jj-octo.on is true; set it to a string" },
      { message: "jj-octo.table is a table; set it to a single value" },
    ]);
  });
});
