import { Command } from "effect/cli";

import { ENVIRONMENT_VARIABLES, GITHUB_AUTH, SETTINGS } from "../../settings";
import { asUserError, type HelpSection, table, withHelp, withSections } from "../command";
import { doctorCommand } from "./doctor";
import { initCommand, setUpOnUpgrade } from "./init";
import { linksCommand } from "./links";
import { logCommand } from "./log";
import { mergeCommand } from "./merge";
import { submitCommand } from "./submit";
import { syncCommand } from "./sync";

// Runs before a command's handler, so before the layers the handler provides, which need a jj
// repository that `init` may be about to make.
const setUpFirst = <const Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
) => Command.provideEffectDiscard(command, asUserError(setUpOnUpgrade));

const settingsSection: HelpSection = {
  lines: [
    "Keys in jj's config. Set one for this repository with `jj config set --repo <key> <value>`, or for every repository with `--user` in place of `--repo`.",
    ...SETTINGS.flatMap((setting) => [
      "",
      setting.key,
      `  ${setting.description}`,
      ...table(
        setting.choices.map(({ description, value }) => [String(value), description]),
        3,
      ).map((row) => `  ${row}`),
      `  Default: ${setting.default.description}`,
    ]),
  ],
  title: "SETTINGS",
};

const environmentSection: HelpSection = {
  lines: table(
    ENVIRONMENT_VARIABLES.map(({ description, name }) => [name, description]),
    3,
  ),
  title: "ENVIRONMENT",
};

export const jjGhCommand = Command.make("jj gh").pipe(
  // `doctor` reports the setup without changing it, and `init` is the setup itself.
  Command.withSubcommands([
    doctorCommand,
    initCommand,
    linksCommand.pipe(setUpFirst),
    logCommand.pipe(setUpFirst),
    mergeCommand.pipe(setUpFirst),
    submitCommand.pipe(setUpFirst),
    syncCommand.pipe(setUpFirst),
  ]),
  withHelp(
    "Commands for publishing jj changes as GitHub pull requests",
    "A stack is a chain of changes, each published as one pull request on the branch its bookmark names. Each pull request targets the branch of the change below it, so it shows only that change's diff. A single change is a stack of one, and is published as an ordinary pull request.",
    "The stack of a change is every change connected to it through mutable changes. An empty working copy with no description isn't part of it. `log` shows the whole stack, and `links` lists its pull requests as Markdown links. `submit` and `merge` act on a change and the ones below it, which must be a chain: no merges, no conflicts, and exactly one bookmark on each change.",
    `The repository is the one the \`origin\` remote points to. Requests to GitHub use only its REST API, so they work through the GitHub proxy of a Claude Code cloud session, which rejects GraphQL. In an Anthropic-hosted session, the default settings work. On a self-hosted runner that sends git through the Anthropic git proxy, set \`${GITHUB_AUTH.key}\` to \`git-proxy\`. SETTINGS and ENVIRONMENT below list the jj config keys and environment variables that change how jj-octo works.`,
  ),
  withSections(settingsSection, environmentSection),
);
