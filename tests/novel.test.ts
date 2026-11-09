/**
 * 小说域：书源解析（真实页面夹具）、成书计划、EPUB 结构、繁简、排序 —— 不打真站。
 *
 * 夹具在 tests/fixtures/novel/，是各站真实页面去掉广告脚本、截短正文后的样子。
 * 努努书坊原页是 GBK，夹具已转存成 UTF-8。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { buildEpub, escapeXml } from '../src/novel/epub.ts'
import { buildZip } from '../src/novel/zip.ts'
import { describeVolumes, makePlan, parseVolumeOption, stripVolumePrefix, volumeSubtitle } from '../src/novel/plan.ts'
import { matchRef, rankHits } from '../src/novel/registry.ts'
import { dropRepeatedTitle, takedownNotice } from '../src/novel/build.ts'
import { sniff } from '../src/novel/image.ts'
import { htmlParagraphs, normalizeTitle, toSimplified } from '../src/novel/text.ts'
import { collectVars, evalTerm, foldHomoglyphs, isWatermark, parseReader, parseToc, splitTopLevel } from '../src/novel/sources/eightnovel.ts'
import {
  mergeIndex, normalizeBookPath, parseBookLinks, parseCategoryPaths, parseKanunuBody, parseKanunuMeta, parseKanunuToc,
  parseWriterLinks, searchIndex, writerPageCount,
} from '../src/novel/sources/kanunu.ts'
import { findCover } from '../src/novel/sources/lnovel.ts'
import { freshChapters } from '../src/novel/subscribe.ts'
import type { BookInfo } from '../src/novel/sources/types.ts'
import { commandGroup, groupCommands } from '../src/main.ts'

const fx = (name: string): string => readFileSync(new URL(`./fixtures/novel/${name}`, import.meta.url), 'utf8')

test('novel 是命令组，scope 跟着命令名走', () => {
  assert.equal(commandGroup('novel'), true)
  for (const c of ['novel search', 'novel get', 'novel job', 'novel subscribe add', 'novel index', 'novel doctor']) {
    assert.ok(groupCommands('novel').includes(c), c)
  }
  assert.ok(!groupCommands('novel').includes('novel _worker'), '内部命令不该出现在清单里')
})

// ---------- 8novel ----------

test('8novel 书页：按卷切目录，章节 id 来自阅读链接', () => {
  const toc = parseToc(fx('8novel-book.html'), '3310')
  assert.ok(toc.length >= 3)
  assert.equal(toc[0]!.title, '第一卷')
  assert.equal(toc[0]!.chapters[0]!.id, '113617')
  assert.equal(toc[0]!.chapters[1]!.title, '第一卷 青春豬頭少年不會夢到兔女郎學姊 第一章 學姐是兔女郎')
  assert.equal(toc[1]!.title, '第二卷')
})

test('8novel 阅读页：变量名随机也能算出正文地址', () => {
  const reader = parseReader(fx('8novel-read.html'))
  assert.equal(reader.ids[0], '113617')
  assert.equal(reader.ids.length, reader.names.length)
  // 实测这两章的地址（抓夹具那次真的取到了正文）
  assert.equal(reader.url('113618'), 'https://www.8novel.com/txt/1/3310/11361859888.html')
  assert.equal(reader.url('113624'), 'https://www.8novel.com/txt/1/3310/11362455896.html')
})

test('8novel 求值：认不出的项直接报错，不猜', () => {
  const env = collectVars("var a='x';var n=3;var arr=\"12,34,abcdefgh\".split(',');")
  assert.deepEqual(splitTopLevel("'%2f'+a+arr[arr.length-1].substr(n * n % 5, 2)"), ["'%2f'", 'a', 'arr[arr.length-1].substr(n * n % 5, 2)'])
  assert.equal(evalTerm('arr[arr.length-n].substr(n * n % 5, 2)', env), '12'.substr(4, 2))
  assert.equal(evalTerm('arr[arr.length-1].substr(n * n % 5, 2)', env), 'efgh'.length ? 'abcdefgh'.substr(4, 2) : '')
  assert.throws(() => evalTerm('foo(1)', env), (err: Error & { code?: string }) => err.code === 'NOVEL_SITE_CHANGED')
})

test('8novel 水印：三种实测变体都删，正文里的英文和短句不删', () => {
  for (const wm of ['⑧ΝОνЕ┕。Сοм', '８ＮОvヨ└．ｃоm', '⒏NσＶｅ└．Ｃом']) assert.equal(isWatermark(wm), true, wm)
  for (const ok of ['Hello world', '8novel.com 真好看', 'OK', '──丟臉。', 'Neko.com', '8.com']) assert.equal(isWatermark(ok), false, ok)
  assert.equal(foldHomoglyphs('⒏'), '8.')
})

test('8novel 正文：水印清掉、段落完整；插图节只有图', () => {
  const paras = htmlParagraphs(fx('8novel-txt.html')).filter((p) => !isWatermark(p))
  assert.ok(paras.length > 10)
  assert.ok(paras.every((p) => !/^p;/.test(p)))
  const images = [...fx('8novel-txt-images.html').matchAll(/<img[^>]+src="([^"]+)"/g)]
  assert.equal(images.length, 12)
})

test('段首残缺实体 p; 删掉，英文里的不动', () => {
  assert.deepEqual(htmlParagraphs('　　p;「班上最可愛」<br><br>keep p; here'), ['「班上最可愛」', 'keep p; here'])
})

// ---------- 努努书坊 ----------

test('kanunu 新版目录（mulu-list）', () => {
  const html = fx('kanunu-toc-new.html')
  const vols = parseKanunuToc(html)
  assert.equal(vols.length, 1)
  assert.ok(vols[0]!.chapters.length > 100)
  assert.match(vols[0]!.chapters[0]!.id, /^\d+$/)
  assert.deepEqual(parseKanunuMeta(html), { title: '我的神话体系和你们不一样', author: '日日复日日' })
})

test('kanunu 老版目录（table 卷名行）', () => {
  const html = fx('kanunu-toc-old.html')
  const vols = parseKanunuToc(html)
  assert.deepEqual(vols.map((v) => v.title).slice(0, 2), ['卷一', '卷二　逐鹿'])
  assert.equal(vols[0]!.chapters.length, 64)
  assert.deepEqual(parseKanunuMeta(html), { title: '尘缘', author: '烟雨江南' })
})

test('kanunu 正文：两种排版都能取出段落', () => {
  const a = parseKanunuBody(fx('kanunu-chapter-new.html'))
  const b = parseKanunuBody(fx('kanunu-chapter-old.html'))
  assert.ok(a.length > 20 && a[0]!.startsWith('日上中天'))
  assert.ok(b.length > 20 && b[0]!.startsWith('那一天，我摇动所有的经桶'))
})

test('kanunu 索引：分类、作家总目、作家页、分类页链接', () => {
  const cats = parseCategoryPaths(fx('kanunu-genres.html'))
  assert.ok(cats.length >= 20 && cats.includes('/zt/'))
  const writersHtml = fx('kanunu-writers.html')
  assert.equal(writerPageCount(writersHtml), 10)
  const writers = parseWriterLinks(writersHtml)
  assert.equal(writers.length, 200)
  assert.ok(writers.every((w) => w.author && !w.author.includes('作品')))
  const books = parseBookLinks(fx('kanunu-writer.html'), '日日复日日')
  assert.ok(books.some((b) => b.title === '我的神话体系和你们不一样' && b.path === '/book7/rrfrr01/'))
  const fromCategory = parseBookLinks(fx('kanunu-category.html'))
  assert.ok(fromCategory.some((b) => b.title === '诛仙'))
})

test('kanunu 索引合并与搜索：同一路径去重，繁体关键词也能搜', () => {
  const merged = mergeIndex([
    [{ path: '/book/1/', title: '活着', author: null }],
    [{ path: '/book/1/', title: '活着', author: '余华' }, { path: '/book/2/', title: '活着之上', author: '阎连科' }],
  ])
  assert.equal(merged.length, 2)
  assert.equal(merged.find((b) => b.path === '/book/1/')!.author, '余华')
  const hits = searchIndex({ builtAt: '', pages: 0, books: merged }, '活著')
  assert.equal(hits.length, 2)
  assert.equal(normalizeBookPath('/book/1/index.html'), '/book/1/')
})

// ---------- lnovel ----------

test('lnovel 封面：og:image 优先，缩略图去后缀', () => {
  const html = fx('lnovel-book.html')
  const cover = findCover(html, '我永遠不會忘記，燦爛一瞬間的你')
  assert.ok(cover && /^https:\/\//.test(cover) && !cover.endsWith('.small.webp'))
  assert.equal(findCover('<img src="/uploads/a.jpg.small.webp" alt="書">', '書'), 'https://lnovel.tw/uploads/a.jpg')
})

// ---------- 输入识别与排序 ----------

test('链接 / 书号识别；认不出的链接直接报错', () => {
  assert.equal(matchRef('https://www.8novel.com/novelbooks/3310/')!.id, '3310')
  assert.equal(matchRef('https://www.8novel.com/read/3310/?113618')!.id, '3310')
  assert.equal(matchRef('https://www.kanunu8.com/book4/10561/index.html')!.id, '/book4/10561/')
  assert.equal(matchRef('3217')!.source.name, 'lnovel')
  assert.equal(matchRef('三体'), null)
  assert.throws(() => matchRef('https://example.com/book/1'), /不认识这个链接/)
})

test('排序：完全一致 > 前缀 > 包含，繁简互通', () => {
  const hits = rankHits('三体', [
    { source: 'kanunu', id: 'c', title: '三体全集', author: null },
    { source: 'kanunu', id: 'a', title: '我的三体', author: null },
    { source: 'kanunu', id: 'b', title: '三體', author: null },
  ])
  assert.deepEqual(hits.map((h) => h.id), ['b', 'c', 'a'])
  assert.equal(normalizeTitle('《活著》'), normalizeTitle('活着'))
})

// ---------- 成书计划 ----------

function sampleBook(): BookInfo {
  return {
    source: 'eightnovel', id: '1', title: '总书名', author: 'A', cover: null, url: 'https://x/',
    volumes: [
      { title: '第一卷', chapters: [{ id: '1', title: '第一卷 兔女郎 主要人物' }, { id: '2', title: '第一卷 兔女郎 第一章 学姐' }] },
      { title: '第二卷', chapters: [{ id: '3', title: '第一章 开头' }, { id: '4', title: '第二章 结尾' }] },
    ],
  }
}

test('卷副标题：全卷一致才算', () => {
  const book = sampleBook()
  assert.equal(volumeSubtitle(book.volumes[0]!), '兔女郎')
  assert.equal(volumeSubtitle(book.volumes[1]!), null)
  assert.equal(stripVolumePrefix('第一卷 兔女郎 第一章 学姐', book.volumes[0]!, '兔女郎'), '第一章 学姐')
  assert.deepEqual(describeVolumes(book).map((v) => v.title), ['第一卷 兔女郎', '第二卷'])
})

test('计划：日轻多卷必须选卷；单卷用副标题当书名；整本章节带卷名', () => {
  const book = sampleBook()
  assert.throws(() => makePlan(book, null, true), (err: Error & { code?: string }) => err.code === 'AMBIGUOUS_VOLUME')
  const v1 = makePlan(book, 1, true)
  assert.equal(v1.title, '兔女郎（第一卷）')
  assert.deepEqual(v1.chapters.map((c) => c.title), ['主要人物', '第一章 学姐'])
  assert.equal(makePlan(book, 2, true).title, '总书名 第二卷')
  const all = makePlan(book, 'all', true)
  assert.equal(all.chapters[2]!.title, '第二卷 第一章 开头')
  // 出版读物的卷只是书内分部：不选卷 = 整本
  assert.equal(makePlan(book, null, false).chapters.length, 4)
  assert.equal(parseVolumeOption('all'), 'all')
  assert.throws(() => parseVolumeOption('x'))
})

test('正文开头重复章节名的段落去掉，正文不误删', () => {
  assert.deepEqual(dropRepeatedTitle(['第一章 学姐', '正文'], '第一卷 第一章 学姐'), ['正文'])
  assert.deepEqual(dropRepeatedTitle(['学姐来了', '正文'], '第一章 学姐'), ['学姐来了', '正文'])
})

test('下架提示不当正文：短正文里的版权提示认出来，长章节提到版权不误判', () => {
  // 8novel 第十四卷实测：每章只有这一句，状态码 200
  assert.ok(takedownNotice(['因版權問題，文庫不再提供該小說的閱讀！']))
  assert.equal(takedownNotice(['他说这本书的版权早就卖掉了。', ...Array.from({ length: 30 }, () => '正文正文正文')]), null)
  assert.equal(takedownNotice(['插图页']), null)
  assert.equal(takedownNotice([]), null)
})

// ---------- 订阅 ----------

test('追更：只有基线里没有的章才算新', () => {
  assert.deepEqual(freshChapters(['1', '2', '3', '4'], ['1', '2', '3']), ['4'])
  assert.deepEqual(freshChapters(['1', '2'], ['1', '2']), [])
})

// ---------- 繁简 ----------

test('繁转简：逐字 + 词组', () => {
  assert.equal(toSimplified('青春豬頭少年不會夢到兔女郎學姊'), '青春猪头少年不会梦到兔女郎学姊')
  assert.equal(toSimplified('一目瞭然'), '一目了然')
  assert.equal(toSimplified('abc 123'), 'abc 123')
})

// ---------- 图片 ----------

test('图片按魔数认格式，图床的 404 页不当图', () => {
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg')
  assert.equal(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'webp')
  assert.equal(sniff(Buffer.from('<!DOCTYPE html><title>404')), 'html')
})

// ---------- zip / EPUB ----------

/** 读 zip 的中央目录：按 EPUB 阅读器的方式解开每个条目。 */
function unzip(buf: Buffer): Map<string, { data: Buffer; method: number; offset: number }> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = buf.readUInt16LE(end + 10)
  let p = buf.readUInt32LE(end + 16)
  const out = new Map<string, { data: Buffer; method: number; offset: number }>()
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50)
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const offset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    const localName = buf.readUInt16LE(offset + 26)
    const localExtra = buf.readUInt16LE(offset + 28)
    const body = buf.subarray(offset + 30 + localName + localExtra, offset + 30 + localName + localExtra + size)
    out.set(name, { data: method === 8 ? inflateRawSync(body) : body, method, offset })
    p += 46 + nameLen
  }
  return out
}

test('zip：条目可解开，UTF-8 文件名', () => {
  const zip = buildZip([{ name: 'a.txt', data: Buffer.from('hello'), store: true }, { name: '中文.txt', data: Buffer.from('世界'.repeat(100)) }])
  const files = unzip(zip)
  assert.equal(files.get('a.txt')!.data.toString(), 'hello')
  assert.equal(files.get('中文.txt')!.data.toString(), '世界'.repeat(100))
})

test('EPUB：mimetype 第一个且不压缩，OPF / NAV / 章节齐全，正文转义', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  const epub = buildEpub({
    identifier: 'test:1', title: 'A & B', author: '作者', language: 'zh-Hans',
    cover: { data: jpeg, mediaType: 'image/jpeg' },
    chapters: [
      { title: '第一章', paragraphs: ['<不是标签>', '第二段'], images: [] },
      { title: '插图', paragraphs: [], images: [{ data: jpeg, mediaType: 'image/jpeg' }] },
    ],
  })
  assert.equal(epub.subarray(30, 38).toString(), 'mimetype')
  assert.equal(epub.subarray(38, 58).toString(), 'application/epub+zip')
  const files = unzip(epub)
  assert.equal(files.get('mimetype')!.method, 0)
  assert.equal(files.get('mimetype')!.offset, 0)
  const opf = files.get('OEBPS/content.opf')!.data.toString()
  assert.match(opf, /<dc:title>A &amp; B<\/dc:title>/)
  assert.match(opf, /properties="cover-image"/)
  assert.match(opf, /<itemref idref="c0002"\/>/)
  assert.match(files.get('OEBPS/c0001.xhtml')!.data.toString(), /<p>&lt;不是标签&gt;<\/p>/)
  assert.match(files.get('OEBPS/c0002.xhtml')!.data.toString(), /images\/c0002_1\.jpg/)
  assert.ok(files.has('OEBPS/nav.xhtml') && files.has('OEBPS/toc.ncx') && files.has('META-INF/container.xml'))
  // 同一本书重复打包，标识不变（阅读器靠它认「同一本」）
  const again = unzip(buildEpub({ identifier: 'test:1', title: 'x', author: null, language: 'zh-Hans', cover: null, chapters: [] }))
  assert.equal(/urn:uuid:[\w-]+/.exec(again.get('OEBPS/content.opf')!.data.toString())![0], /urn:uuid:[\w-]+/.exec(opf)![0])
  assert.equal(escapeXml('a\u0001b'), 'ab')
})
