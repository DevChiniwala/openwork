import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { unloadableSourceExports, workspaceSpecifiersIn } from "../scripts/build.mjs"

/**
 * A service with one workspace package served from TypeScript source, like @openwork/types: `broken` imports a
 * sibling without a file extension (what Node can't resolve at runtime), `fine` imports one with its real extension
 * only as a type, and `built` is served from dist. The package lives outside node_modules and is linked in, as pnpm
 * links workspace packages (Node refuses to strip types under a real node_modules path).
 */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "den-build-exports-"))
  const pkg = path.join(root, "packages", "fixture")
  mkdirSync(path.join(pkg, "src"), { recursive: true })
  mkdirSync(path.join(root, "node_modules", "@openwork"), { recursive: true })
  symlinkSync(pkg, path.join(root, "node_modules", "@openwork", "fixture"), "dir")
  mkdirSync(path.join(pkg, "dist"), { recursive: true })
  writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "@openwork/fixture",
      type: "module",
      exports: {
        "./broken": { development: "./src/broken.ts", default: "./src/broken.ts" },
        "./fine": { development: "./src/fine.ts", default: "./src/fine.ts" },
        "./built": { development: "./src/broken.ts", default: "./dist/built.js" },
      },
    }),
  )
  writeFileSync(path.join(pkg, "src", "sibling.ts"), "export const sibling: number = 1\n")
  writeFileSync(path.join(pkg, "src", "broken.ts"), 'import { sibling } from "./sibling"\nexport const broken: number = sibling\n')
  writeFileSync(path.join(pkg, "src", "fine.ts"), 'import type { Sibling } from "./types"\nexport const fine: Sibling = 1\n')
  writeFileSync(path.join(pkg, "src", "types.ts"), "export type Sibling = number\n")
  writeFileSync(path.join(pkg, "dist", "built.js"), "export const built = 1\n")
  const dist = path.join(root, "dist")
  mkdirSync(path.join(dist, "routes"), { recursive: true })
  writeFileSync(path.join(dist, "main.js"), 'import { broken } from "@openwork/fixture/broken"\nimport { fine } from "@openwork/fixture/fine"\n')
  writeFileSync(path.join(dist, "routes", "lazy.js"), 'const built = await import("@openwork/fixture/built")\n')
  return { root, dist }
}

test("the build finds every workspace import in the compiled service, including dynamic ones", () => {
  const { root, dist } = fixture()
  try {
    assert.deepEqual(workspaceSpecifiersIn(dist), ["@openwork/fixture/broken", "@openwork/fixture/built", "@openwork/fixture/fine"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a source-served export with an import Node can't resolve fails the build; working and dist-served ones pass", () => {
  const { root, dist } = fixture()
  try {
    const failures = unloadableSourceExports(workspaceSpecifiersIn(dist), root)
    assert.equal(failures.length, 1, failures.join("\n"))
    assert.match(failures[0] ?? "", /^@openwork\/fixture\/broken: Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module .*sibling'/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
