// 冒烟测试运行器：用 esbuild 的 JS API（自动找到本机平台二进制）打包后执行。
// 用法：node scripts/run-supply-test.mjs [testName]（默认 supply）
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const name = process.argv[2] || 'supply'
const entry = resolve('src/test', `${name}.test.ts`)
const outfile = resolve('node_modules/.cache', `${name}-test.mjs`)
mkdirSync(dirname(outfile), { recursive: true })

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { '@': resolve('src') },
  outfile,
  logLevel: 'warning',
})

const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' })
process.exit(result.status ?? 1)
