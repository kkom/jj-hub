import { writeFileSync } from "node:fs";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { Effect, type FileSystem, Layer } from "effect";

import type { Git } from "../clients/git";
import type { Jj } from "../clients/jj";
import {
  executor,
  isolatedEnv,
  layerAt,
  type ScratchRepository,
  scratchDirectory,
} from "./scratch-repository";

/**
 * A plain git clone of a repository's `origin`, with no jj repository, and git's identity, under
 * `name`, set in its own config. jj reads an empty configuration, so it has no identity of its own.
 * `layerAt` gives the git and jj clients in another directory, such as a worktree of the clone.
 */
export const gitClone = (
  repository: ScratchRepository,
  name = "Cloner",
): {
  readonly git: (...args: readonly string[]) => string;
  readonly jj: (...args: readonly string[]) => string;
  /** The jj config file that jj reads in place of the user's. */
  readonly jjConfigFile: string;
  readonly layer: Layer.Layer<Git | Jj>;
  readonly layerAt: (directory: string) => Layer.Layer<Git | Jj>;
} => {
  const root = scratchDirectory("clone-");
  const env = isolatedEnv(root);
  const jjConfigFile = env["JJ_CONFIG"] ?? "";
  writeFileSync(jjConfigFile, "");
  const execute = executor(env);
  const checkout = path.join(root, "checkout");
  const origin = repository.git("remote", "get-url", "origin").trim();
  execute(root, ["git", "clone", "--quiet", origin, checkout]);
  execute(checkout, ["git", "config", "user.name", name]);
  execute(checkout, ["git", "config", "user.email", "cloner@example.com"]);
  const printed: string[] = [];
  const print = (text: string): void => {
    printed.push(text);
  };
  return {
    git: (...args) => execute(checkout, ["git", ...args]),
    jj: (...args) => execute(checkout, ["jj", ...args]),
    jjConfigFile,
    layer: layerAt(checkout, env, print),
    layerAt: (directory) => layerAt(directory, env, print),
  };
};

/** Runs the program with the git and jj clients of the layer, and the runtime's own services. */
export const runIn = <A, E>(
  layer: Layer.Layer<Git | Jj>,
  program: Effect.Effect<A, E, FileSystem.FileSystem | Git | Jj>,
): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(Layer.merge(layer, BunServices.layer))));
