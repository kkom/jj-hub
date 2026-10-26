import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import manifest from "../package.json" with { type: "json" };
import { SET_UP_VERSION } from "./cli/gh/setup";
import {
  type InterceptedRequest,
  type InterceptingProxy,
  throughProxy,
} from "./testing/intercepting-proxy";
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

interface RunOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

// Asynchronous, so the proxy in this process can answer while the file runs.
const output = async (command: readonly string[], args: readonly string[], options: RunOptions) => {
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
  return { stderr, stdout };
};

const run = async (command: readonly string[], args: readonly string[], options: RunOptions) => {
  const { stdout } = await output(command, args, options);
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

// The environment that sends jj-octo's requests through the proxy, with a token it can pass on.
const proxyEnv = ({ caFile, url }: InterceptingProxy) => ({
  GH_TOKEN: "test-token",
  HTTPS_PROXY: url,
  NODE_EXTRA_CA_CERTS: caFile,
});

// A repository with change `a` on `main`, whose `origin` is a GitHub repository, and the
// environment that runs the file in it with its own configuration. It records this version as
// the one that set it up, as `init` does, since `init` can't reach that `origin`.
const checkoutOfA = () => {
  const repository = scratchRepository();
  repository.stack("a");
  repository.jj("git", "remote", "set-url", "origin", "https://github.com/owner/name");
  repository.jj("config", "set", "--repo", SET_UP_VERSION, JSON.stringify(manifest.version));
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
          ...proxyEnv(proxy),
        },
      });
    });
    expect(received).toStrictEqual({
      log: [
        "CONNECT api.github.com:443",
        "GET api.github.com/repos/owner/name/pulls?state=all&head=owner:a&per_page=100",
      ],
      result: "👀 [#7 Add a](https://github.com/owner/name/pull/7) +1/-0\n",
    });
  });

  it("tells the agent to reply with the links, with --copy in a Claude Code cloud session", async () => {
    const received = await throughProxy("api.github.com", listOfA, (proxy) => {
      const { cwd, env } = checkoutOfA();
      return output(command, ["links", "--copy"], {
        cwd,
        env: {
          ...env,
          CLAUDE_CODE_REMOTE: "true",
          ...proxyEnv(proxy),
        },
      });
    });
    expect(received.result).toStrictEqual({
      stderr:
        "This Claude Code cloud session can't reach the user's clipboard. To give the user the links, put the Markdown links this command printed in your reply, outside a code block. The Claude app shows them as links, which paste into Slack as links.\n",
      stdout: "👀 [#7 Add a](https://github.com/owner/name/pull/7) +1/-0\n",
    });
  });

  it("tries to set a checkout up before a command where no version is recorded", async () => {
    const received = await throughProxy("api.github.com", pullRequestOfA, async (proxy) => {
      const { cwd, env, repository } = checkoutOfA();
      repository.jj("config", "unset", "--repo", SET_UP_VERSION);
      const { stderr, stdout } = await output(command, ["log"], {
        cwd,
        env: { ...env, ...proxyEnv(proxy) },
      });
      // What git prints between them depends on the network, which the test doesn't control.
      const printed = stderr.trimEnd().split("\n");
      return {
        firstPrinted: printed.at(0),
        lastPrinted: printed.at(-1),
        recorded: repository.jj("config", "get", SET_UP_VERSION),
        stdout,
      };
    });
    // `init` can't reach this `origin` with git, so it says what's left and the command carries on.
    expect(received).toStrictEqual({
      // The first is `init`'s `git ls-remote`, which the proxy doesn't answer for github.com.
      log: ["CONNECT github.com:443", ...logOfA.log],
      result: {
        firstPrinted: `setting this checkout up for jj-octo ${manifest.version}`,
        lastPrinted: "run `jj-octo init` once that's fixed",
        recorded: `${manifest.version}\n`,
        stdout: logOfA.result,
      },
    });
  });

  it("reads pull requests through the proxy HTTPS_PROXY names", async () => {
    const received = await throughProxy("api.github.com", pullRequestOfA, (proxy) => {
      const { cwd, env } = checkoutOfA();
      return run(command, ["log"], {
        cwd,
        env: {
          ...env,
          ...proxyEnv(proxy),
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
          ...proxyEnv(proxy),
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
          ...proxyEnv(proxy),
        },
      });
    });
    expect(received).toStrictEqual(logOfA);
  });
});
