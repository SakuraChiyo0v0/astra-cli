// 打包到 dist/：
//
//   dist/astra.mjs                     入口桩：几行，只负责 import 当前版本
//   dist/releases/<版本>/astra.mjs      真正的入口
//   dist/releases/<版本>/chunks/*.mjs   按领域切出来的块
//
// 进容器只要一个 Node 24 和 dist 整个目录，没有 node_modules。
//
// 0.56.0 起切块（splitting）：domains.ts 里每个 `import('./x/manifest.ts')` 都是一个切点，
// 跑 `astra music get` 只加载入口 + music 那几块，不再把 20 个领域、9.8 MB 全部解析一遍。
//
// 为什么要桩 + 版本目录：产物从一个文件变成一个目录后，「原地覆盖」不再是原子的 ——
// 后台任务的 worker 正在跑时换掉一半 chunk，它下一次懒加载就会拿到新旧混杂的代码。
// 现在部署 = 先把新版本目录整个放好，再原子地换掉几行的桩；旧版本目录留着，回滚就是把桩写回去。
// 调用方式不变：`node /opt/astra/bin/astra.mjs …`
import { build } from 'esbuild'
import { readFileSync, chmodSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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

// 旧产物里的 chunk 文件名带哈希，不清掉会越积越多
rmSync('dist', { recursive: true, force: true })
const outdir = `dist/releases/${version}`

await build({
  entryPoints: { astra: 'src/main.ts' },
  outdir,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  outExtension: { '.js': '.mjs' },
  splitting: true,
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

// 入口桩。`__astraEntry` 告诉 main.ts「我是被桩当入口启动的」—— main 靠比对 argv[1]
// 和自己的路径判断要不要执行，经桩启动时两者不同（见 src/main.ts 的 isEntry）。
writeFileSync(
  'dist/astra.mjs',
  [
    '#!/usr/bin/env node',
    `// astra ${version} 的入口桩（scripts/build.mjs 生成）。换版本 = 换这个文件；版本目录在 releases/ 下`,
    'globalThis.__astraEntry = import.meta.url',
    `await import('./releases/${version}/astra.mjs')`,
    '',
  ].join('\n'),
)
chmodSync('dist/astra.mjs', 0o755)
chmodSync(`${outdir}/astra.mjs`, 0o755)
const chunks = readdirSync(`${outdir}/chunks`)
const entryBytes = statSync(`${outdir}/astra.mjs`).size
const total = chunks.reduce((n, f) => n + statSync(`${outdir}/chunks/${f}`).size, entryBytes)
console.log(`dist/astra.mjs ${version}（入口 ${(entryBytes / 1024).toFixed(0)} KB + ${chunks.length} 块，共 ${(total / 1024 / 1024).toFixed(1)} MB → ${outdir}）`)
