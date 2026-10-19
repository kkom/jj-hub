#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { CliConfig, Command, GlobalFlag } from "effect/cli";

import manifest from "../package.json" with { type: "json" };
import { jjGhCommand } from "./cli/gh/command";
import { GitLive } from "./clients/git";
import { JjLive } from "./clients/jj";

NodeRuntime.runMain(
  Command.run(jjGhCommand, { version: manifest.version }).pipe(
    Effect.provide([GitLive, JjLive]),
    // The completions flag is left out. Its script completes a command of this name, but the shell
    // gives everything after `jj` to jj's own completions.
    Effect.provide(
      CliConfig.layer({
        builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Wizard, GlobalFlag.LogLevel],
      }),
    ),
    Effect.provide(NodeServices.layer),
  ),
);
