import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

import { lines } from "../cli/gh/stack/changes";
import { type Git, gitLayer } from "../clients/git";
import { type ListedPullRequest, PullRequestNumberSchema } from "../clients/github/types";
import { type Jj, jjLayer } from "../clients/jj";
import { PrDescriptions, prDescriptionsLayer } from "../clients/pr-descriptions";

/**
 * A jj repository with `main` pushed to a bare `origin`, for tests that run the real jj. A second,
 * plain git clone of `origin` stands in for GitHub changing branches by itself.
 */
export interface ScratchRepository {
  /** The names of the branches on `origin`, with the commit each points at. */
  readonly branches: () => Readonly<Record<string, string>>;
  /**
   * Runs jj in a second jj clone of `origin`, made on first use. It stands in for another checkout
   * of the same person, whose pushes keep each change's id.
   */
  readonly elsewhere: (...args: readonly string[]) => string;
  /** The files in the revision, sorted. */
  readonly files: (revision: string) => readonly string[];
  /** Runs git in the clone standing in for GitHub. */
  readonly git: (...args: readonly string[]) => string;
  /** Runs jj in the repository, and returns what it printed. */
  readonly jj: (...args: readonly string[]) => string;
  readonly layer: Layer.Layer<Git | Jj | PrDescriptions>;
  /** Runs the effect with the repository's recorded pull request descriptions. */
  readonly records: <A>(
    effect: (store: PrDescriptions["Service"]) => Effect.Effect<A>,
  ) => Promise<A>;
  /** The same clients in another directory, such as a workspace added to the repository. */
  readonly layerAt: (directory: string) => Layer.Layer<Git | Jj | PrDescriptions>;
  /** Each described change above the trunk, bottom to top, as `description [bookmarks]`. */
  readonly log: () => readonly string[];
  /** Records that GitHub merged a pull request from the branch, whose head was the commit. */
  readonly mergedOnGitHub: (branch: string, head: string) => void;
  /** What the jj commands that `layer` ran to change something printed, in order. */
  readonly printed: () => string;
  /** The pull requests from the branch that `mergedOnGitHub` recorded, newest first. */
  readonly pullRequestsFrom: (branch: string) => readonly ListedPullRequest[];
  /** Adds one change per name on top of `main`, each with a file and a bookmark of that name. */
  readonly stack: (...names: readonly string[]) => void;
  /** Writes a file into the working copy of the second jj clone. */
  readonly writeElsewhere: (file: string, content: string) => void;
  /** Writes a file into the clone standing in for GitHub. */
  readonly writeOnGitHub: (file: string, content: string) => void;
  /** Writes a file into the jj working copy. */
  readonly write: (file: string, content: string) => void;
}

// Spotlight on macOS doesn't index a directory named `.noindex`, and each test writes and deletes
// a few hundred small files.
const parent = path.join(tmpdir(), "jj-octo-tests.noindex");

const directories: string[] = [];

/** A new directory, removed by `removeScratchRepositories`. */
export const scratchDirectory = (prefix: string): string => {
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, prefix));
  directories.push(directory);
  return directory;
};

export const removeScratchRepositories = (): void => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
};

/**
 * The environment that keeps git and jj from reading the configuration of whoever runs the tests.
 * jj reads `config.toml` in the root instead.
 */
export const isolatedEnv = (root: string): Readonly<Record<string, string>> => ({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  JJ_CONFIG: path.join(root, "config.toml"),
});

/** Runs a command in a directory with the environment, and returns what it printed. */
export const executor =
  (env: Readonly<Record<string, string>>) =>
  (cwd: string, command: readonly string[]): string => {
    const result = Bun.spawnSync([...command], { cwd, env: { ...Bun.env, ...env } });
    if (result.exitCode !== 0) {
      throw new Error(`${command.join(" ")} failed:\n${result.stderr.toString()}`);
    }
    return result.stdout.toString();
  };

/**
 * The git and jj clients, running in a directory with the environment. What jj commands that
 * change something print goes to `printed`, rather than into the test's output.
 */
export const layerAt = (
  cwd: string,
  env: Readonly<Record<string, string>>,
  printed: (text: string) => void,
): Layer.Layer<Git | Jj | PrDescriptions> =>
  Layer.merge(
    gitLayer({ cwd, env }),
    Layer.provideMerge(prDescriptionsLayer, jjLayer({ cwd, env, printed })),
  ).pipe(Layer.provide(BunServices.layer));

// The repository in a directory that already holds one: `origin.git`, `repository`, `github`
// and the jj configuration.
const open = (root: string): ScratchRepository => {
  const repository = path.join(root, "repository");
  const github = path.join(root, "github");
  const env = {
    ...isolatedEnv(root),
    GIT_AUTHOR_EMAIL: "github@example.com",
    GIT_AUTHOR_NAME: "GitHub",
    GIT_COMMITTER_EMAIL: "github@example.com",
    GIT_COMMITTER_NAME: "GitHub",
  };
  const execute = executor(env);
  const jj = (...args: readonly string[]): string => execute(repository, ["jj", ...args]);
  const git = (...args: readonly string[]): string => execute(github, ["git", ...args]);
  const other = path.join(root, "elsewhere");
  const cloneElsewhere = (): void => {
    if (!existsSync(other)) {
      execute(root, ["jj", "git", "clone", path.join(root, "origin.git"), other]);
    }
  };
  const elsewhere = (...args: readonly string[]): string => {
    cloneElsewhere();
    return execute(other, ["jj", ...args]);
  };
  const write = (file: string, content: string): void => {
    writeFileSync(path.join(repository, file), content);
  };
  const merged: { readonly branch: string; readonly pullRequest: ListedPullRequest }[] = [];
  const printed: string[] = [];
  const layerIn = (directory: string) =>
    layerAt(directory, env, (text) => {
      printed.push(text);
    });
  const layer = layerIn(repository);

  return {
    branches: () =>
      Object.fromEntries(
        lines(git("ls-remote", "--heads", "origin")).map((line) => {
          const [commit = "", ref = ""] = line.split("\t");
          return [ref.replace("refs/heads/", ""), commit];
        }),
      ),
    elsewhere,
    files: (revision) => lines(jj("file", "list", "-r", revision)),
    git,
    jj,
    layer,
    layerAt: layerIn,
    log: () =>
      lines(
        jj(
          "log",
          "--no-graph",
          "--reversed",
          "-r",
          'trunk().. ~ description(exact:"")',
          "-T",
          String.raw`description.first_line() ++ " [" ++ local_bookmarks.map(|b| b.name()).join(",") ++ "]\n"`,
        ),
      ),
    mergedOnGitHub: (branch, head) => {
      const number = merged.length + 1;
      merged.unshift({
        branch,
        pullRequest: {
          head,
          number: PullRequestNumberSchema.make(number),
          state: "merged",
          title: branch,
          url: `https://github.com/kkom/jj-octo/pull/${number}`,
        },
      });
    },
    printed: () => printed.join(""),
    pullRequestsFrom: (branch) =>
      merged.filter((recorded) => recorded.branch === branch).map(({ pullRequest }) => pullRequest),
    records: (effect) =>
      Effect.runPromise(Effect.flatMap(PrDescriptions, effect).pipe(Effect.provide(layer))),
    stack: (...names) => {
      jj("new", "main");
      for (const name of names) {
        jj("describe", "-m", name);
        write(`${name}.txt`, `${name}\n`);
        jj("bookmark", "create", name, "-r", "@");
        jj("new");
      }
    },
    write,
    writeElsewhere: (file, content) => {
      cloneElsewhere();
      writeFileSync(path.join(other, file), content);
    },
    writeOnGitHub: (file, content) => {
      writeFileSync(path.join(github, file), content);
    },
  };
};

// Running jj and git a dozen times per test is most of what the tests cost, so each kind of
// repository is built once per run and copied. The two git configurations hold the path of
// `origin.git`, which is rewritten to the copy's.
const templates = new Map<string, string>();

const templateOf = (name: string, build: (root: string) => void): string => {
  mkdirSync(parent, { recursive: true });
  let template = templates.get(name);
  if (template === undefined) {
    template = mkdtempSync(path.join(parent, `template-${name}-`));
    templates.set(name, template);
    build(template);
  }
  return template;
};

const duplicate = (from: string, to: string): void => {
  cpSync(from, to, { preserveTimestamps: true, recursive: true });
  for (const config of ["repository/.git/config", "github/.git/config"]) {
    const file = path.join(to, config);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll(from, to));
  }
};

const copyOf = (template: string): string => {
  const root = scratchDirectory("repository-");
  duplicate(template, root);
  return root;
};

process.on("exit", () => {
  for (const template of templates.values()) {
    rmSync(template, { force: true, recursive: true });
  }
});

const buildBase = (root: string): void => {
  writeFileSync(
    path.join(root, "config.toml"),
    '[user]\nname = "Test"\nemail = "test@example.com"\n',
  );
  mkdirSync(path.join(root, "repository"));
  const { jj, write } = open(root);
  Bun.spawnSync(["git", "init", "--quiet", "--bare", "--initial-branch=main", "origin.git"], {
    cwd: root,
  });
  jj("git", "init", "--colocate");
  jj("git", "remote", "add", "origin", path.join(root, "origin.git"));
  jj("describe", "-m", "base");
  write("base.txt", "base\n");
  jj("bookmark", "create", "main", "-r", "@");
  jj("git", "push", "--bookmark", "main");
  Bun.spawnSync(["git", "clone", "--quiet", path.join(root, "origin.git"), "github"], {
    cwd: root,
  });
};

const baseTemplate = (): string => templateOf("base", buildBase);

/** A repository with only `main`, pushed. */
export const scratchRepository = (): ScratchRepository => open(copyOf(baseTemplate()));

/** A repository with one change per name stacked on `main`, each pushed with its bookmark. */
export const pushedStack = (...names: readonly string[]): ScratchRepository =>
  open(
    copyOf(
      templateOf(`pushed-${names.join("-")}`, (root) => {
        duplicate(baseTemplate(), root);
        const built = open(root);
        built.stack(...names);
        built.jj("git", "push", ...names.flatMap((name) => ["--bookmark", name]));
      }),
    ),
  );
