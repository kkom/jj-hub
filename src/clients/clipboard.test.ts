import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

import { removeScratchRepositories, scratchDirectory } from "../testing/scratch-repository";
import { Clipboard, ClipboardFailed, clipboardLayer, MACOS_SCRIPT } from "./clipboard";

afterAll(removeScratchRepositories);

const content = {
  html: '<a href="https://example.com">#1 Add a</a>',
  text: "[#1 Add a](https://example.com)",
};

const writeWith = (layer: Layer.Layer<Clipboard>) =>
  Effect.flatMap(Clipboard, (clipboard) => clipboard.write(content)).pipe(Effect.provide(layer));

const layerFor = (platform: string, env: Readonly<Record<string, string>> = {}) =>
  clipboardLayer({ env, platform }).pipe(Layer.provide(BunServices.layer));

/**
 * A directory holding a stand-in for the command, which records its arguments and stdin, and
 * leaves a process behind as xclip and wl-copy do to hold the clipboard.
 */
const standIn = (command: string, exitCode = 0) => {
  const directory = scratchDirectory("clipboard-");
  const script = path.join(directory, command);
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > "${directory}/args"`,
      `cat > "${directory}/stdin"`,
      "sleep 30 &",
      `echo $! > "${directory}/held"`,
      `exit ${exitCode}`,
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  // The PATH holds only what the stand-in runs, so a real clipboard command can't run instead.
  for (const tool of ["cat", "sleep"]) {
    symlinkSync(Bun.which(tool) ?? tool, path.join(directory, tool));
  }
  const read = (file: string) => readFileSync(path.join(directory, file), "utf8");
  const held = () => Number(read("held").trim());
  return {
    PATH: directory,
    recorded: () => {
      // A killed process can stay as a zombie, which `ps` shows with the state Z.
      const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(held())]).stdout.toString();
      const alive = state.trim() !== "" && !state.startsWith("Z");
      if (alive) {
        process.kill(held());
      }
      return { alive, args: read("args"), stdin: read("stdin") };
    },
  };
};

describe("clipboardLayer", () => {
  it("sets the HTML and the text with osascript on macOS", async () => {
    const osascript = standIn("osascript");
    await Effect.runPromise(writeWith(layerFor("darwin", { PATH: osascript.PATH })));
    expect(osascript.recorded()).toStrictEqual({
      alive: true,
      args: ["-l", "JavaScript", "-e", MACOS_SCRIPT, content.html, content.text, ""].join("\n"),
      stdin: "",
    });
  });

  it("pipes the HTML to wl-copy under Wayland, leaving its process running", async () => {
    const wlCopy = standIn("wl-copy");
    await Effect.runPromise(
      writeWith(layerFor("linux", { PATH: wlCopy.PATH, WAYLAND_DISPLAY: "wayland-0" })),
    );
    expect(wlCopy.recorded()).toStrictEqual({
      alive: true,
      args: "--type\ntext/html\n",
      stdin: content.html,
    });
  });

  it("pipes the HTML to xclip under X, leaving its process running", async () => {
    const xclip = standIn("xclip");
    await Effect.runPromise(
      writeWith(layerFor("linux", { PATH: xclip.PATH, WAYLAND_DISPLAY: "" })),
    );
    expect(xclip.recorded()).toStrictEqual({
      alive: true,
      args: "-selection\nclipboard\n-t\ntext/html\n",
      stdin: content.html,
    });
  });

  it("falls back to xclip under Wayland where wl-copy isn't installed", async () => {
    const xclip = standIn("xclip");
    await Effect.runPromise(
      writeWith(layerFor("linux", { PATH: xclip.PATH, WAYLAND_DISPLAY: "wayland-0" })),
    );
    expect(xclip.recorded()).toStrictEqual({
      alive: true,
      args: "-selection\nclipboard\n-t\ntext/html\n",
      stdin: content.html,
    });
  });

  it("fails naming the command where it exits non-zero", async () => {
    const xclip = standIn("xclip", 1);
    const failure = await Effect.runPromise(
      Effect.flip(writeWith(layerFor("linux", { PATH: xclip.PATH, WAYLAND_DISPLAY: "" }))),
    );
    xclip.recorded();
    expect(failure).toStrictEqual(new ClipboardFailed({ message: "xclip exited with 1" }));
  });

  it("fails naming the command where it isn't installed", async () => {
    const empty = scratchDirectory("clipboard-");
    const failure = await Effect.runPromise(
      Effect.flip(writeWith(layerFor("linux", { PATH: empty, WAYLAND_DISPLAY: "" }))),
    );
    expect(failure).toStrictEqual(
      new ClipboardFailed({
        message: "couldn't find xclip",
      }),
    );
  });

  it("fails on a platform it has no command for", async () => {
    const failure = await Effect.runPromise(Effect.flip(writeWith(layerFor("win32"))));
    expect(failure).toStrictEqual(
      new ClipboardFailed({
        message: "copying to the clipboard needs macOS, or Linux with wl-copy or xclip, not win32",
      }),
    );
  });
});
