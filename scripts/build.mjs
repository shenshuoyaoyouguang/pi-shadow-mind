import { copyFile, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const entryPoint = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const declarationEntry = fileURLToPath(new URL("../.build/types/index.d.ts", import.meta.url));
const declarationDirectory = fileURLToPath(new URL("../.build", import.meta.url));
const distDirectory = fileURLToPath(new URL("../dist", import.meta.url));
const outfile = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const publicDeclaration = fileURLToPath(new URL("../dist/index.d.ts", import.meta.url));

const buildResult = await build({
  entryPoints: [entryPoint],
  outfile,
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "node20",
  sourcemap: true,
  metafile: true,
  external: ["node:*", "@earendil-works/*", "typebox"],
});

const externalImports = Object.values(buildResult.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter((item) => item.external)
  .map((item) => item.path);
const unexpectedExternalImports = externalImports.filter((path) =>
  path !== "typebox" && !path.startsWith("typebox/") && !path.startsWith("node:") && !path.startsWith("@earendil-works/"),
);
if (unexpectedExternalImports.length > 0) {
  throw new Error(`Unexpected external runtime imports: ${unexpectedExternalImports.join(", ")}`);
}

const bundle = await readFile(outfile, "utf8");
if (bundle.includes("__require(")) {
  throw new Error("ESM bundle contains an esbuild CommonJS require shim");
}

await copyFile(declarationEntry, publicDeclaration);
await rm(declarationDirectory, { recursive: true, force: true });

const emittedFiles = await readdir(distDirectory, { recursive: true });
const expectedFiles = new Set(["index.d.ts", "index.js", "index.js.map"]);
const unexpectedFiles = emittedFiles.filter((path) => !expectedFiles.has(path));
if (unexpectedFiles.length > 0) {
  throw new Error(`Unexpected files in dist: ${unexpectedFiles.join(", ")}`);
}

// Load through native ESM so build-time checks cannot be masked by Jiti's CJS compatibility layer.
await import(`${pathToFileURL(outfile).href}?build-smoke=${Date.now()}`);
