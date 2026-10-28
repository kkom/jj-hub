import { describe, expect, it } from "bun:test";

import { Context } from "effect";
import type { HelpDoc } from "effect/cli";

import { helpFormatter, HelpSections, table } from "./command";

const doc = (annotations: Context.Context<never>): HelpDoc.HelpDoc => ({
  annotations,
  description: "Does things",
  flags: [],
  usage: "tool [flags]",
});

describe("table", () => {
  it("lines each column up past the widest cell before it, counting a wide character as two", () => {
    expect(
      table(
        [
          ["a", "short", ""],
          ["👀", "wider", "end"],
          ["longer", "x"],
        ],
        2,
      ),
    ).toStrictEqual(["a       short", "👀      wider  end", "longer  x"]);
  });
});

describe("helpFormatter", () => {
  it("shows each section after the generated ones, with its lines indented", () => {
    const formatter = helpFormatter(false);
    const sections = Context.make(HelpSections, [
      { lines: ["first", "", "second"], title: "ONE" },
      {
        lines: table(
          [
            ["a", "short"],
            ["longer", "wide"],
          ],
          3,
        ),
        title: "TWO",
      },
    ]);
    expect(formatter.formatHelpDoc(doc(sections))).toBe(
      [
        "DESCRIPTION",
        "  Does things",
        "",
        "USAGE",
        "  tool [flags]",
        "",
        "ONE",
        "  first",
        "",
        "  second",
        "",
        "TWO",
        "  a        short",
        "  longer   wide",
      ].join("\n"),
    );
  });

  it("shows only the generated sections for a command without any", () => {
    const formatter = helpFormatter(false);
    expect(formatter.formatHelpDoc(doc(Context.empty()))).toBe(
      ["DESCRIPTION", "  Does things", "", "USAGE", "  tool [flags]"].join("\n"),
    );
  });
});
