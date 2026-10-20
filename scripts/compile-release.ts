// Compiles a standalone jj-octo, which carries the Bun runtime, for each platform a GitHub release
// offers. Each goes into `dist/release` as the tarball that installers such as mise expect,
// holding one executable named `jj-octo`.
import { $ } from "bun";

// The x64 build is Bun's baseline one, which runs on CPUs without AVX2.
const targets: readonly Bun.Build.CompileTarget[] = [
  "bun-darwin-arm64",
  "bun-linux-arm64",
  "bun-linux-x64-baseline",
];

await $`rm -rf dist/compile dist/release && mkdir -p dist/release`;
for (const target of targets) {
  const platform = target.replace(/^bun-/u, "").replace(/-baseline$/u, "");
  const directory = `dist/compile/${platform}`;
  // oxlint-disable-next-line no-await-in-loop -- each build downloads its runtime into Bun's shared cache
  await Bun.build({
    // Jj-octo runs in other people's checkouts, whose `.env` and `bunfig.toml` aren't its own.
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      outfile: `${directory}/jj-octo`,
      target,
    },
    entrypoints: ["src/main.ts"],
    throw: true,
  });
  // oxlint-disable-next-line no-await-in-loop -- each archive needs its build
  await $`tar --create --gzip --file dist/release/jj-octo-${platform}.tar.gz --directory ${directory} jj-octo`;
}
