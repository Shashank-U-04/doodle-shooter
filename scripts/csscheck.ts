// Temporary: compile src/index.css through Tailwind v4 to catch CSS errors.
import fs from "node:fs/promises";
import { compile } from "@tailwindcss/node";

const css = await fs.readFile("src/index.css", "utf8");
try {
  const compiler = await compile(css, {
    base: process.cwd(),
    onDependency: () => {},
  });
  const out = compiler.build(["flex", "grid"]);
  console.log("CSS OK, bytes:", out.length);
} catch (e) {
  console.log("CSS FAIL:", (e as Error).message);
  console.log((e as Error).stack?.split("\n").slice(0, 6).join("\n"));
}
