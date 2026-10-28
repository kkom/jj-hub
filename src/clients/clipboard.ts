import { Config, Context, Data, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { claudeCodeCloudSession, WAYLAND_DISPLAY } from "../settings";

export class ClipboardFailed extends Data.TaggedError("ClipboardFailed")<{
  readonly message: string;
}> {}

/** Text with formatting, and the same text without it for apps that take only plain text. */
export interface RichText {
  readonly html: string;
  readonly text: string;
}

/**
 * What a write did: `unreachable` in a Claude Code cloud session, where the user's clipboard is on
 * another device, so nothing was copied.
 */
export type ClipboardWrite = "copied" | "unreachable";

export class Clipboard extends Context.Service<
  Clipboard,
  { readonly write: (content: RichText) => Effect.Effect<ClipboardWrite, ClipboardFailed> }
>()("jj-octo/Clipboard") {}

// Sets the HTML and the plain text on macOS's pasteboard, where AppleScript's `set the clipboard`
// sets plain text alone. osascript passes the arguments after the script to `run`, and exits
// non-zero where it throws.
export const MACOS_SCRIPT = `
ObjC.import("AppKit");
function run([html, text]) {
  const pasteboard = $.NSPasteboard.generalPasteboard;
  pasteboard.clearContents;
  if (
    !pasteboard.setStringForType($(html), $.NSPasteboardTypeHTML) ||
    !pasteboard.setStringForType($(text), $.NSPasteboardTypeString)
  ) {
    throw new Error("the pasteboard didn't take the links");
  }
}`;

interface ClipboardOptions {
  /** `process.platform` by default. */
  readonly platform?: string;
}

/** The environment variables the clipboard reads, empty where unset. */
const environment = Config.all({
  path: Config.String("PATH").pipe(Config.withDefault("")),
  wayland: Config.String(WAYLAND_DISPLAY.name).pipe(Config.withDefault("")),
});

interface ClipboardCommand {
  readonly name: string;
  readonly args: readonly string[];
  /** Whether the command reads the HTML from stdin, or takes the content as arguments. */
  readonly input: "arguments" | "stdin";
}

/**
 * The clipboard commands for the platform, the first one installed to run. On Linux the commands
 * take one type, so the clipboard gets the HTML alone. Under Wayland, xclip works through
 * XWayland where wl-copy isn't installed.
 */
const commandsFor = (
  { html, text }: RichText,
  platform: string,
  wayland: string,
): readonly ClipboardCommand[] => {
  if (platform === "darwin") {
    return [
      {
        args: ["-l", "JavaScript", "-e", MACOS_SCRIPT, html, text],
        input: "arguments",
        name: "osascript",
      },
    ];
  }
  if (platform !== "linux") {
    return [];
  }
  const xclip: ClipboardCommand = {
    args: ["-selection", "clipboard", "-t", "text/html"],
    input: "stdin",
    name: "xclip",
  };
  return wayland === ""
    ? [xclip]
    : [{ args: ["--type", "text/html"], input: "stdin", name: "wl-copy" }, xclip];
};

/**
 * Runs the executable found for the command. The commands that read the HTML from stdin leave a
 * process behind that holds the clipboard. It would die with a detached process group, and keeps
 * any stdout or stderr it inherits open, which would block a caller reading them. So their output
 * is dropped, and osascript's isn't.
 */
const childProcess = (
  { args, input }: ClipboardCommand,
  executable: string,
  html: string,
): ChildProcess.Command =>
  ChildProcess.make(executable, args, {
    detached: false,
    stdout: "ignore",
    ...(input === "stdin"
      ? { stderr: "ignore", stdin: Stream.make(html).pipe(Stream.encodeText) }
      : { stderr: "inherit", stdin: "ignore" }),
  });

export const clipboardLayer = ({ platform = process.platform }: ClipboardOptions = {}): Layer.Layer<
  Clipboard,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.effect(
    Clipboard,
    Effect.gen(function* () {
      // Each variable defaults to empty, and any string is valid, so reading them can't fail.
      const { path, wayland } = yield* Effect.orDie(environment);
      if (yield* claudeCodeCloudSession) {
        return Clipboard.of({ write: () => Effect.succeed("unreachable" as const) });
      }
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return Clipboard.of({
        write: (content) => {
          const commands = commandsFor(content, platform, wayland);
          if (commands.length === 0) {
            return Effect.fail(
              new ClipboardFailed({
                message: `copying to the clipboard needs macOS, or Linux with wl-copy or xclip, not ${platform}`,
              }),
            );
          }
          const [installed] = commands.flatMap((command) => {
            const executable = Bun.which(command.name, { PATH: path });
            return executable === null ? [] : [{ command, executable }];
          });
          if (installed === undefined) {
            const names = commands.map(({ name }) => name).join(" or ");
            return Effect.fail(new ClipboardFailed({ message: `couldn't find ${names}` }));
          }
          const { command, executable } = installed;
          const { name } = command;
          return spawner.exitCode(childProcess(command, executable, content.html)).pipe(
            Effect.catchTag("PlatformError", (error) =>
              Effect.fail(new ClipboardFailed({ message: `${name} failed: ${error.message}` })),
            ),
            Effect.flatMap((code) =>
              code === 0
                ? Effect.succeed("copied" as const)
                : Effect.fail(new ClipboardFailed({ message: `${name} exited with ${code}` })),
            ),
          );
        },
      });
    }),
  );

export const ClipboardLive = clipboardLayer();
