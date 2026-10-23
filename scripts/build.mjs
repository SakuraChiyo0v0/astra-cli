// 打成单文件 dist/astra.mjs：进容器只要一个 Node 24 和这个文件，没有 node_modules。
import { build } from 'esbuild'
import { readFileSync, chmodSync } from 'node:fs'
import path from 'node:path'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/**
 * steam-user 给单文件打包留的两个坑（都实测过）：
 *
 * 1. 它的依赖 `@doctormckay/stdlib` 在**函数体里**动态 `require('crypto')`，esbuild 的
 *    ESM 产物没有 `require`，直接报 `Dynamic require of "crypto" is not supported`。
 *    解法：banner 里用 `createRequire` 定义一个真的 `require` —— esbuild 的 `__require`
 *    垫片会优先用它（垫片实现是 `typeof require !== 'undefined' ? require : …`）。
 * 2. `@doctormckay/steam-crypto` 用 `__dirname` 读 `system.pem`，单文件里没有这个文件。
 *    解法：下面的插件把 pem 内联成字符串常量；banner 再补一个 `__dirname` 兜底。
 */
const inlineSteamPem = {
  name: 'inline-steam-crypto-pem',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /@doctormckay[\\/]steam-crypto[\\/]index\.js$/ }, (args) => {
      const pem = readFileSync(path.join(path.dirname(args.path), 'system.pem'), 'utf8')
      const source = readFileSync(args.path, 'utf8').replace(
        /require\(['"]fs['"]\)\.readFileSync\(__dirname \+ ['"]\/system\.pem['"]\)/,
        JSON.stringify(pem),
      )
      if (source.includes('/system.pem')) throw new Error('steam-crypto 读 system.pem 的写法变了，改 build.mjs 里的正则')
      return { contents: source, loader: 'js' }
    })
  },
}

/**
 * 第二个坑：`steam-user/components/cdn_compression.js` 里
 * `const LZMA = requireWithFallback('lzma-native', 'lzma');` 是**动态** require，
 * esbuild 看不到，运行时 bundle 旁边没有 node_modules → 整个 steam-user 加载失败。
 *
 * 这个 lzma 只在解 **VZIP 压缩的 CDN 清单**时用（挂时长根本不碰），而 `lzma` 包自己
 * 还要按 __dirname 找 src/lzma_worker.js，塞进单文件反而更脆。所以直接换成一个
 * 「真用到才报错」的桩：模块能正常加载，真去解 VZIP 时给出明确错误。
 */
const stubLzma = {
  name: 'stub-lzma',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /steam-user[\/]components[\/]cdn_compression\.js$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8').replace(
        /const LZMA = requireWithFallback\('lzma-native', 'lzma'\);/,
        "const LZMA = { decompress() { throw new Error('这份构建没带 lzma：VZIP 压缩的 CDN 清单解不开（挂时长用不到）'); } };",
      )
      if (source.includes("requireWithFallback('lzma-native'")) throw new Error('cdn_compression.js 的 lzma 写法变了，改 build.mjs')
      return { contents: source, loader: 'js' }
    })
  },
}

const banner = {
  js: [
    "import { createRequire as __astraCreateRequire } from 'node:module'",
    "import { fileURLToPath as __astraFileURLToPath } from 'node:url'",
    "import { dirname as __astraDirname } from 'node:path'",
    'const require = __astraCreateRequire(import.meta.url)',
    'const __filename = __astraFileURLToPath(import.meta.url)',
    'const __dirname = __astraDirname(__filename)',
  ].join('\n'),
}

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/astra.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // node:sqlite 是内置模块，esbuild 0.28 已认识；保险起见显式排除所有 node: 前缀
  external: ['node:*'],
  // shebang 来自 src/main.ts 第一行，esbuild 会保留；banner 会排在 shebang 之后
  banner,
  plugins: [inlineSteamPem, stubLzma],
  define: { ASTRA_VERSION: JSON.stringify(version) },
  legalComments: 'none',
  logLevel: 'warning',
})
chmodSync('dist/astra.mjs', 0o755)
console.log(`dist/astra.mjs ${version}`)
