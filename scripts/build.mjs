// 打成单文件 dist/astra.mjs：进容器只要一个 Node 24 和这个文件，没有 node_modules。
import { build } from 'esbuild'
import { readFileSync, chmodSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/astra.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // node:sqlite 是内置模块，esbuild 0.28 已认识；保险起见显式排除所有 node: 前缀
  external: ['node:*'],
  // shebang 来自 src/main.ts 第一行，esbuild 会保留；再加 banner 会变成两行 shebang
  define: { ASTRA_VERSION: JSON.stringify(version) },
  legalComments: 'none',
  logLevel: 'warning',
})
chmodSync('dist/astra.mjs', 0o755)
console.log(`dist/astra.mjs ${version}`)
