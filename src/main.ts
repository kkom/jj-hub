#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { CliConfig, CliOutput, Command, GlobalFlag, TerminalCapabilities } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import manifest from "../package.json" with { type: "json" };
import { helpFormatter } from "./cli/command";
import { jjGhCommand } from "./cli/gh/command";
import { GitLive } from "./clients/git";
import { JjLive } from "./clients/jj";
import { prDescriptionsLayer } from "./clients/pr-descriptions";

BunRuntime.runMain(
  Command.run(jjGhCommand, { version: manifest.version }).pipe(
    Effect.provide([GitLive, Layer.provideMerge(prDescriptionsLayer, JjLive)]),
    // The completions flag is left out. Its script completes a command of this name, but the shell
    // gives everything after `jj` to jj's own completions.
    Effect.provide(
      CliConfig.layer({
        builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Wizard, GlobalFlag.LogLevel],
      }),
    ),
    Effect.provide([
      BunServices.layer,
      Layer.effect(CliOutput.Formatter)(
        Effect.map(TerminalCapabilities.TerminalCapabilities, ({ canColor }) =>
          helpFormatter(canColor),
        ),
      ),
      FetchHttpClient.layer,
    ]),
  ),
);
