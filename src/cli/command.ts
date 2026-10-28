import { Effect } from "effect";
import { CliError, CliOutput, Command, Flag } from "effect/cli";

const userError = (message: string): CliError.UserError =>
  new CliError.UserError({ cause: message, userMessage: message });

// Every failure the commands raise is one a person can act on, so each is shown as a message
// rather than a stack trace.
export const asUserError = <A, R>(
  program: Effect.Effect<A, { readonly _tag: string; readonly message: string }, R>,
): Effect.Effect<A, CliError.UserError, R> =>
  program.pipe(Effect.mapError(({ message }) => userError(message)));

// The summary is the line a parent command lists. The command's own help shows it above the
// paragraphs, which are indented here because the help formatter only indents the first line.
export const withHelp =
  (summary: string, ...paragraphs: readonly string[]) =>
  <Name extends string, Input, ContextInput, E, R>(
    command: Command.Command<Name, Input, ContextInput, E, R>,
  ): Command.Command<Name, Input, ContextInput, E, R> =>
    command.pipe(
      Command.withShortDescription(summary),
      Command.withDescription([summary, ...paragraphs].join("\n\n  ")),
    );

/** Rows of cells, each column lined up `gap` spaces past the widest cell of the one before it. */
export const table = (rows: readonly (readonly string[])[], gap: number): readonly string[] => {
  const width = (column: number): number =>
    Math.max(0, ...rows.map((row) => CliOutput.displayWidth(row[column] ?? "")));
  return rows.map((row) =>
    row
      .map((cell, column) => `${cell}${" ".repeat(width(column) - CliOutput.displayWidth(cell))}`)
      .join(" ".repeat(gap))
      .trimEnd(),
  );
};

/** `-r`, as jj has it. The working copy is the default, as it is for jj's own commands. */
export const revisionFlag = (description: string): Flag.Flag<string> =>
  Flag.String("revision").pipe(
    Flag.withAlias("r"),
    Flag.withDefault("@"),
    Flag.withDescription(`${description}, the working copy by default`),
  );
