#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { CliConfig, Command, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import manifest from "../package.json" with { type: "json" };
import { jjGhCommand } from "./cli/gh/command";
import { GitLive } from "./clients/git";
import { JjLive } from "./clients/jj";

BunRuntime.runMain(
  Command.run(jjGhCommand, { version: manifest.version }).pipe(
    Effect.provide([GitLive, JjLive]),
    // The completions flag is left out. Its script completes a command of this name, but the shell
    // gives everything after `jj` to jj's own completions.
    Effect.provide(
      CliConfig.layer({
        builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Wizard, GlobalFlag.LogLevel],
      }),
    ),
    Effect.provide([BunServices.layer, FetchHttpClient.layer]),
  ),
);
