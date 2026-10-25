import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import manifest from "../package.json" with { type: "json" };
import { type InterceptedRequest, throughProxy } from "./testing/intercepting-proxy";
import {
  isolatedEnv,
  removeScratchRepositories,
  scratchRepository,
} from "./testing/scratch-repository";

afterAll(removeScratchRepositories);

// What `bun run test` builds first: the file npm publishes, run through its shebang as an
// installed command is, and the standalone executable, which carries Bun, for this platform.
const dist = path.join(import.meta.dirname, "..", "dist");
const builds = [
  { command: [path.join(dist, "jj-octo.js")], name: "the built file" },
  { command: [path.join(dist, "jj-octo")], name: "the standalone executable" },
];

// The environment of the tests, without the proxy settings it may hold, which would otherwise
// route requests past the proxy under test.
const proxySettings = new Set(["http_proxy", "https_proxy", "no_proxy", "node_extra_ca_certs"]);
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !proxySettings.has(key.toLowerCase())),
);

// Asynchronous, so the proxy in this process can answer while the file runs.
const run = async (
  command: readonly string[],
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
) => {
  const child = Bun.spawn([...command, ...args], {
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
    throw new Error(`jj-octo ${args.join(" ")} failed:\n${stderr}`);
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

// GitHub's answer to a request for every pull request from branch `a`.
const listOfA = ({ path: requestPath }: InterceptedRequest) =>
  requestPath === "/repos/owner/name/pulls?state=all&head=owner:a&per_page=100"
    ? [
        {
          draft: false,
          head: { sha: "0000000" },
          html_url: "https://github.com/owner/name/pull/7",
          merged_at: null,
          number: 7,
          state: "open",
          title: "Add a",
        },
      ]
    : [];

// A repository with change `a` on `main`, whose `origin` is a GitHub repository, and the
// environment that runs the file in it with its own configuration.
const checkoutOfA = () => {
  const repository = scratchRepository();
  repository.stack("a");
  repository.jj("git", "remote", "set-url", "origin", "https://github.com/owner/name");
  const cwd = repository.jj("root").trim();
  return { cwd, env: isolatedEnv(path.dirname(cwd)), repository };
};

describe.each(builds)("$name", ({ command }) => {
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

  it("links the pull requests GitHub lists for a branch", async () => {
    const received = await throughProxy("api.github.com", listOfA, (proxy) => {
      const { cwd, env } = checkoutOfA();
      return run(command, ["links"], {
        cwd,
        env: {
          ...env,
          GH_TOKEN: "test-token",
          HTTPS_PROXY: proxy.url,
          NODE_EXTRA_CA_CERTS: proxy.caFile,
        },
      });
    });
    expect(received).toStrictEqual({
      log: [
        "CONNECT api.github.com:443",
        "GET api.github.com/repos/owner/name/pulls?state=all&head=owner:a&per_page=100",
      ],
      result: "👀 [#7 Add a](https://github.com/owner/name/pull/7)\n",
    });
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

  // The checkout is someone else's, so neither its `.env` nor its `bunfig.toml` may change how
  // jj-octo runs. Loaded, this `.env` would send the request past the proxy.
  it("ignores a .env file in the checkout", async () => {
    const received = await throughProxy("api.github.com", pullRequestOfA, (proxy) => {
      const { cwd, env } = checkoutOfA();
      // Excluded, so jj doesn't record it.
      appendFileSync(path.join(cwd, ".git", "info", "exclude"), ".env\n");
      writeFileSync(path.join(cwd, ".env"), "NO_PROXY=*\n");
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

  // Loaded, the checkout's `bunfig.toml` would run its preload inside jj-octo, which fails the run.
  it("ignores a bunfig.toml file in the checkout", async () => {
    const received = await throughProxy("api.github.com", pullRequestOfA, (proxy) => {
      const { cwd, env } = checkoutOfA();
      // Excluded, so jj doesn't record them.
      appendFileSync(path.join(cwd, ".git", "info", "exclude"), "bunfig.toml\npreload.ts\n");
      writeFileSync(path.join(cwd, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
      writeFileSync(
        path.join(cwd, "preload.ts"),
        'console.error("ran the checkout\'s bunfig.toml preload");\nprocess.exit(3);\n',
      );
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
