import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: false,
  logLevel: "info"
};

await Promise.all([
  build({ ...common, entryPoints: ["../agent/src/index.ts"], outfile: "dist/agent.cjs" }),
  build({ ...common, entryPoints: ["../relay/src/index.ts"], outfile: "dist/relay.cjs" })
]);
