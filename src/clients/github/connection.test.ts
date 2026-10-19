import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect";

import { gitClone } from "../../testing/git-clone";
import {
  removeScratchRepositories,
  scratchDirectory,
  scratchRepository,
} from "../../testing/scratch-repository";
import { authKey, connection } from "./connection";

afterAll(removeScratchRepositories);

/** A colocated jj repository, with the git and jj clients and an environment holding `env`. */
const checkout = (env: Readonly<Record<string, string>> = {}) => {
  const clone = gitClone(scratchRepository());
  clone.jj("git", "init", "--colocate");
  const layer = Layer.mergeAll(
    clone.layer,
    NodeServices.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...env } })),
  );
  const resolve = () =>
    Effect.runPromise(
      connection.pipe(
        Effect.map(({ proxy, token }) => ({
          proxy: Option.getOrUndefined(
            Option.map(proxy, ({ ca, url }) => ({ ca: Option.getOrUndefined(ca), url })),
          ),
          token: Redacted.value(token),
        })),
        Effect.provide(layer),
      ),
    );
  const failure = () =>
    Effect.runPromise(Effect.flip(connection.pipe(Effect.provide(layer)))).then(
      ({ message }) => message,
    );
  return { ...clone, failure, resolve };
};

describe("connection", () => {
  it("sends the token from the environment by default", async () => {
    const { resolve } = checkout({ GH_TOKEN: "own-token" });
    expect(await resolve()).toStrictEqual({ proxy: undefined, token: "own-token" });
  });

  it("sends a placeholder through git's proxy for github.com, trusting git's CA bundle", async () => {
    const { git, jj, resolve } = checkout();
    const ca = path.join(scratchDirectory("ca-"), "ca.pem");
    writeFileSync(ca, "certificate\n");
    git("config", "http.https://github.com/.proxy", "http://127.0.0.1:1234");
    git("config", "http.https://github.com/.sslCAInfo", ca);
    jj("config", "set", "--repo", authKey, "git-proxy");
    expect(await resolve()).toStrictEqual({
      proxy: { ca: "certificate\n", url: "http://127.0.0.1:1234" },
      token: "proxy-injected",
    });
  });

  it("uses the system's certificate authorities where git names no CA bundle", async () => {
    const { git, jj, resolve } = checkout();
    git("config", "http.proxy", "http://127.0.0.1:1234");
    jj("config", "set", "--repo", authKey, "git-proxy");
    expect(await resolve()).toStrictEqual({
      proxy: { ca: undefined, url: "http://127.0.0.1:1234" },
      token: "proxy-injected",
    });
  });

  it("fails for git-proxy where git has no proxy for github.com", async () => {
    const { failure, git, jj } = checkout({ GH_TOKEN: "own-token" });
    git("config", "http.https://example.com/.proxy", "http://127.0.0.1:1234");
    jj("config", "set", "--repo", authKey, "git-proxy");
    expect(await failure()).toBe(
      "jj-octo.github-auth is git-proxy, but git has no http.proxy for https://github.com",
    );
  });

  it("fails for a value it doesn't know", async () => {
    const { failure, jj } = checkout({ GH_TOKEN: "own-token" });
    jj("config", "set", "--repo", authKey, "proxy");
    expect(await failure()).toBe('jj-octo.github-auth is "proxy"; set it to token or git-proxy');
  });
});
