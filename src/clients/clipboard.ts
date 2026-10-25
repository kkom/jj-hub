import { Context, Data, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class ClipboardFailed extends Data.TaggedError("ClipboardFailed")<{
  readonly message: string;
}> {}

/** Text with formatting, and the same text without it for apps that take only plain text. */
export interface RichText {
  readonly html: string;
  readonly text: string;
}

export class Clipboard extends Context.Service<
  Clipboard,
  { readonly write: (content: RichText) => Effect.Effect<void, ClipboardFailed> }
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
  /** Added to the environment the clipboard command inherits. */
  readonly env?: Readonly<Record<string, string>>;
}

interface ClipboardCommand {
  readonly command: ChildProcess.Command;
  readonly name: string;
}

/**
 * The clipboard commands for the platform, the first one installed to run. On Linux the commands
 * take one type, so the clipboard gets the HTML alone. Under Wayland, xclip works through
 * XWayland where wl-copy isn't installed.
 */
const commandsFor = (
  { html, text }: RichText,
  platform: string,
  env: Readonly<Record<string, string>>,
): readonly ClipboardCommand[] => {
  // The commands that read the HTML from stdin leave a process behind that holds the clipboard.
  // It would die with a detached process group, and keeps any stdout or stderr it inherits open,
  // which would block a caller reading them. So their output is dropped, and osascript's isn't.
  const make = (
    name: string,
    args: readonly string[],
    input: "arguments" | "stdin",
  ): ClipboardCommand => ({
    command: ChildProcess.make(name, args, {
      detached: false,
      env,
      extendEnv: true,
      stdout: "ignore",
      ...(input === "stdin"
        ? { stderr: "ignore", stdin: Stream.make(html).pipe(Stream.encodeText) }
        : { stderr: "inherit", stdin: "ignore" }),
    }),
    name,
  });
  if (platform === "darwin") {
    return [make("osascript", ["-l", "JavaScript", "-e", MACOS_SCRIPT, html, text], "arguments")];
  }
  if (platform !== "linux") {
    return [];
  }
  const xclip = make("xclip", ["-selection", "clipboard", "-t", "text/html"], "stdin");
  const wayland = env["WAYLAND_DISPLAY"] ?? process.env["WAYLAND_DISPLAY"] ?? "";
  return wayland === "" ? [xclip] : [make("wl-copy", ["--type", "text/html"], "stdin"), xclip];
};

export const clipboardLayer = ({
  env = {},
  platform = process.platform,
}: ClipboardOptions = {}): Layer.Layer<Clipboard, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(
    Clipboard,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return {
        write: (content) => {
          const commands = commandsFor(content, platform, env);
          if (commands.length === 0) {
            return Effect.fail(
              new ClipboardFailed({
                message: `copying to the clipboard needs macOS, or Linux with wl-copy or xclip, not ${platform}`,
              }),
            );
          }
          const PATH = env["PATH"] ?? process.env["PATH"] ?? "";
          const installed = commands.find(({ name }) => Bun.which(name, { PATH }) !== null);
          if (installed === undefined) {
            const names = commands.map(({ name }) => name).join(" or ");
            return Effect.fail(new ClipboardFailed({ message: `couldn't find ${names}` }));
          }
          const { command, name } = installed;
          return spawner.exitCode(command).pipe(
            Effect.catchTag("PlatformError", (error) =>
              Effect.fail(new ClipboardFailed({ message: `${name} failed: ${error.message}` })),
            ),
            Effect.flatMap((code) =>
              code === 0
                ? Effect.void
                : Effect.fail(new ClipboardFailed({ message: `${name} exited with ${code}` })),
            ),
          );
        },
      };
    }),
  );

export const ClipboardLive = clipboardLayer();
