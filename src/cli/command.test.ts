import { describe, expect, it } from "bun:test";

import { table } from "./command";

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
