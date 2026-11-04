import { readFileSync } from "node:fs";
import { build } from "esbuild";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  sourcemap: false,
  external: ["viem", "viem/*", "@sentora/*"],
  logLevel: "info",
  define: {
    __YIELDS_CLIENT_VERSION__: JSON.stringify(version),
  },
});
