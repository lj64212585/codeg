import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "esbuild"

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const output = resolve(packageDir, "dist", "cli.cjs")

await mkdir(dirname(output), { recursive: true })
await build({
  entryPoints: [resolve(packageDir, "src", "cli.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: false,
  legalComments: "none",
})
