import { afterAll, describe, expect, it } from "bun:test";
import path from "node:path";

import manifest from "../package.json" with { type: "json" };
import { type InterceptedRequest, throughProxy } from "./testing/intercepting-proxy";
import {
  isolatedEnv,
  removeScratchRepositories,
  scratchRepository,
} from "./testing/scratch-repository";

afterAll(removeScratchRepositories);

// The file `bun run build` writes, which npm publishes. `bun run test` builds it first.
const built = path.join(import.meta.dirname, "..", "dist", "jj-octo.js");

// CI runs the file on one runtime per job, and a local run tries both.
const runtime = process.env["JJ_OCTO_RUNTIME"];
const runtimes = runtime === undefined ? ["bun", "node"] : [runtime];

// The environment of the tests, without the proxy settings it may hold. An empty value wouldn't
// do, since undici reads an empty `https_proxy` as no proxy, ahead of `HTTPS_PROXY`.
const proxySettings = new Set(["http_proxy", "https_proxy", "no_proxy", "node_extra_ca_certs"]);
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !proxySettings.has(key.toLowerCase())),
);

// Asynchronous, so the proxy in this process can answer while the file runs.
const run = async (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
) => {
  const child = Bun.spawn([command, built, ...args], {
    cwd: options.cwd,
    env: { ...inherited, ...options.env },
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command} jj-octo ${args.join(" ")} failed:\n${stderr}`);
  }
  return stdout;
};

// GitHub's answer to a request for the open pull requests from branch `a`.
const pullRequestOfA = ({ path: requestPath }: InterceptedRequest) =>
  requestPath === "/repos/owner/name/pulls?state=open&head=owner:a"
    ? [{ base: { ref: "main" }, body: "", draft: true, number: 7, title: "a" }]
    : [];

// What the proxy receives and `log` prints when `log` reads that pull request.
const logOfA = {
  log: [
    "CONNECT api.github.com:443",
    "GET api.github.com/repos/owner/name/pulls?state=open&head=owner:a",
  ],
  result: "a  #7 draft  not pushed\n",
};

// A repository with change `a` on `main`, whose `origin` is a GitHub repository, and the
// environment that runs the file in it with its own configuration.
const checkoutOfA = () => {
  const repository = scratchRepository();
  repository.stack("a");
  repository.jj("git", "remote", "set-url", "origin", "https://github.com/owner/name");
  const cwd = repository.jj("root").trim();
  return { cwd, env: isolatedEnv(path.dirname(cwd)), repository };
};

describe.each(runtimes)("the built file on %s", (command) => {
  it("prints its version", async () => {
    expect(await run(command, ["--version"], { cwd: process.cwd(), env: {} })).toBe(
      `jj gh v${manifest.version}\n`,
    );
  });

  it("reads pull requests through git's proxy for github.com", async () => {
    const received = await throughProxy("api.github.com", pullRequestOfA, (proxy) => {
      const { cwd, env, repository } = checkoutOfA();
      const git = (...args: readonly string[]) =>
        repository.jj("util", "exec", "--", "git", "config", ...args);
      git("http.https://github.com/.proxy", proxy.url);
      git("http.https://github.com/.sslCAInfo", proxy.caFile);
      repository.jj("config", "set", "--repo", "jj-octo.github-auth", "git-proxy");
      return run(command, ["log"], { cwd, env });
    });
    expect(received).toStrictEqual(logOfA);
  });

  it("reads pull requests through the proxy HTTPS_PROXY names", async () => {
    const received = await throughProxy("api.github.com", pullRequestOfA, (proxy) => {
      const { cwd, env } = checkoutOfA();
      return run(command, ["log"], {
        cwd,
        env: {
          ...env,
          GH_TOKEN: "test-token",
          HTTPS_PROXY: proxy.url,
          NODE_EXTRA_CA_CERTS: proxy.caFile,
        },
      });
    });
    expect(received).toStrictEqual(logOfA);
  });
});
