import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { compile } from "tailwindcss";

const require = createRequire(import.meta.url);
const typographyRequire = createRequire(
  require.resolve("@tailwindcss/typography")
);
const { commonTrailingPseudos } = typographyRequire("./utils.js") as {
  commonTrailingPseudos(selector: string): [string | null, string];
};

// Typography pins parser v6; its security override uses v7. Exercise the real
// selector consumer and CSS compiler to keep the override compatible.
describe("Tailwind typography selector parsing", () => {
  it.each([
    ["ol > li::marker, ul > li::marker", ["::marker", "ol > li, ul > li"]],
    ["code::before, code::after", [null, "code::before, code::after"]],
    ["a:hover::before, b:focus::before", ["::before", "a:hover, b:focus"]],
    [
      'a[href="x,y"]::before, code::before',
      ["::before", 'a[href="x,y"], code'],
    ],
  ] as const)(
    "preserves pseudo-element semantics for %s",
    (selector, expected) => {
      expect(commonTrailingPseudos(selector)).toEqual(expected);
    }
  );

  it("compiles prose styles with pseudo-elements outside the exclusion selector", async () => {
    const compiler = await compile(
      '@plugin "@tailwindcss/typography"; @tailwind utilities;',
      {
        loadModule: async () => ({
          path: require.resolve("@tailwindcss/typography"),
          module: require("@tailwindcss/typography"),
          base: process.cwd(),
        }),
      }
    );
    const css = compiler.build(["prose"]);
    const exclusion =
      ':not(:where([class~="not-prose"],[class~="not-prose"] *))';

    expect(css).toContain(".prose {");
    expect(css).toContain(`:where(ul > li)${exclusion}::marker {`);
    expect(css).toContain(`:where(code)${exclusion}::before {`);
    expect(css).toContain(`:where(code)${exclusion}::after {`);
  });
});
