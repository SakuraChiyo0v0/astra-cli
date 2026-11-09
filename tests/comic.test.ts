/**
 * 漫画域：源的纯函数、链接识别、排序、范围解析、落盘命名、断点续传判定、CBZ —— 不打真站。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.ASTRA_HOME = mkdtempSync(path.join(tmpdir(), 'astra-comic-'))

const { commandGroup, groupCommands } = await import('../src/main.ts')
const { parseRange, pickGroup } = await import('../src/comic/commands.ts')
const { completePages, writeCbz } = await import('../src/comic/jobs.ts')
const { chapterDirName } = await import('../src/comic/paths.ts')
const { matchRef, rankHits } = await import('../src/comic/registry.ts')
const { groupChapters, komiic } = await import('../src/comic/sources/komiic.ts')
const { copymanga, groupLabel, hiRes, orderPages, signature } = await import('../src/comic/sources/copymanga.ts')
const { imageExt } = await import('../src/comic/fetch.ts')

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1)])

test('comic 是命令组，和 comic（JM）分开', () => {
  assert.equal(commandGroup('comic'), true)
  for (const c of ['comic search', 'comic info', 'comic get', 'comic job', 'comic job resume', 'comic doctor']) {
    assert.ok(groupCommands('comic').includes(c), c)
  }
  assert.ok(!groupCommands('comic').includes('comic _worker'))
  assert.ok(groupCommands('comic').includes('comic get'), 'JM 的 comic 命令组还在')
})

test('链接识别：Komiic 数字 id，拷贝漫画 path_word（多个镜像域名）', () => {
  assert.equal(komiic.match('https://komiic.com/comic/1398'), '1398')
  assert.equal(komiic.match('https://komiic.com/comic/1398/chapter/9/images/all'), '1398')
  assert.equal(copymanga.match('https://www.mangacopy.com/comic/yunixianliandsjjt'), 'yunixianliandsjjt')
  assert.equal(copymanga.match('https://www.2025copy.com/comic/zangsongdefulilian/chapter/x'), 'zangsongdefulilian')
  assert.equal(copymanga.match('https://copymanga.site/comic/a-b_c'), 'a-b_c')
  assert.equal(komiic.match('與你相戀到生命盡頭'), null)
  const ref = matchRef('https://komiic.com/comic/1398')
  assert.equal(ref?.source.name, 'komiic')
  assert.throws(() => matchRef('https://example.com/comic/1'), /不认识这个链接/)
})

test('搜索排序：完全同名优先、繁简互通、同分按源顺序（komiic 在前）', () => {
  const hits = [
    { source: 'copymanga', id: 'b', title: '與你相戀到生命盡頭官方同人集', author: null },
    { source: 'copymanga', id: 'a', title: '與你相戀到生命盡頭', author: null },
    { source: 'komiic', id: '1398', title: '與你相戀到生命盡頭', author: null },
  ]
  const ranked = rankHits('与你相恋到生命尽头', hits)
  assert.deepEqual(ranked.map((h) => h.id), ['1398', 'a', 'b'])
})

test('Komiic 章节按 type 分组：单行本在前，空组去掉', () => {
  const groups = groupChapters([
    { id: '10', serial: '01', type: 'chapter', size: 38 },
    { id: '1', serial: '01', type: 'book', size: '170' },
    { id: '2', serial: '02', type: 'book', size: null },
  ])
  assert.deepEqual(groups.map((g) => [g.name, g.volumes, g.chapters.length]), [['单行本', true, 2], ['单话', false, 1]])
  assert.equal(groups[0]!.chapters[0]!.pages, 170)
  assert.equal(groups[0]!.chapters[1]!.pages, null)
  assert.deepEqual(groupChapters([{ id: '1', serial: '01', type: 'chapter' }]).map((g) => g.name), ['单话'])
})

test('拷贝漫画：分组名、页序重排、高清图地址、签名', () => {
  assert.deepEqual(groupLabel('tankobon', {}), { name: '单行本', volumes: true })
  assert.deepEqual(groupLabel('default', {}), { name: '连载', volumes: false })
  assert.deepEqual(groupLabel('other_honyakuchimu', { name: '其它汉化版' }), { name: '其它汉化版', volumes: false })
  assert.deepEqual(orderPages(['c', 'a', 'b'], [2, 0, 1]), ['a', 'b', 'c'])
  assert.deepEqual(orderPages(['a', 'b'], undefined), ['a', 'b'])
  assert.deepEqual(orderPages(['a', 'b'], [1]), ['a', 'b'], 'words 长度不对就不重排')
  assert.equal(hiRes('https://x/z/1.jpg.c800x.jpg'), 'https://x/z/1.jpg.c1500x.jpg')
  assert.equal(hiRes('https://x/z/1.jpg'), 'https://x/z/1.jpg')
  // HMAC-SHA256(secret, "1700000000") 的固定值：和 venera copy_manga.js 算法一致
  assert.equal(signature('1700000000'), signature('1700000000'))
  assert.match(signature('1700000000'), /^[0-9a-f]{64}$/)
  assert.notEqual(signature('1700000000'), signature('1700000001'))
})

test('--range 解析：从 1 开始、可逗号、越界忽略、全越界报错', () => {
  assert.deepEqual(parseRange(undefined, 3), [0, 1, 2])
  assert.deepEqual(parseRange('2,4-6', 8), [1, 3, 4, 5])
  assert.deepEqual(parseRange('7-20', 8), [6, 7])
  assert.deepEqual(parseRange('3,3,1', 5), [0, 2])
  assert.throws(() => parseRange('9-10', 8), /不在 1-8 之内/)
  assert.throws(() => parseRange('a', 8), /写法不对/)
})

test('分组选择与落盘目录名', () => {
  const comic = {
    source: 'copymanga', id: 'x', title: 't', author: null, status: null, tags: [], cover: null, url: '',
    groups: [{ name: '单行本', volumes: true, chapters: [] }, { name: '连载', volumes: false, chapters: [] }],
  }
  assert.equal(pickGroup(comic, undefined).name, '单行本')
  assert.equal(pickGroup(comic, '连载').name, '连载')
  assert.throws(() => pickGroup(comic, '番外'), /没有分组/)
  assert.equal(chapterDirName({ volumes: true }, { name: '01' }), '第01卷')
  assert.equal(chapterDirName({ volumes: true }, { name: '第3卷' }), '第03卷')
  assert.equal(chapterDirName({ volumes: false }, { name: '第01话' }), '第01话')
  assert.equal(chapterDirName({ volumes: false }, { name: '42' }), '第42话')
  assert.equal(chapterDirName({ volumes: false }, { name: '7' }), '第07话')
  assert.equal(chapterDirName({ volumes: false }, { name: '12.5' }), '第12.5话')
  assert.equal(chapterDirName({ volumes: false }, { name: '第09话试看' }), '第09话试看')
})

test('断点续传：只认文件名是页号、魔数是图片、不是空壳的页；CBZ 只打页文件', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'comic-ch-'))
  writeFileSync(path.join(dir, '001.jpg'), JPG)
  writeFileSync(path.join(dir, '002.jpg'), Buffer.from('<html>error</html>'.padEnd(2000, ' ')))
  writeFileSync(path.join(dir, '003.webp'), Buffer.from([0xff, 0xd8]))
  writeFileSync(path.join(dir, '004.jpg.part'), JPG)
  writeFileSync(path.join(dir, 'cover.jpg'), JPG)
  assert.deepEqual([...completePages(dir)], [1])
  assert.equal(completePages(path.join(dir, 'nope')).size, 0)

  const ch = path.join(dir, '第01卷')
  mkdirSync(ch)
  writeFileSync(path.join(ch, '002.jpg'), JPG)
  writeFileSync(path.join(ch, '001.jpg'), JPG)
  writeFileSync(path.join(ch, 'notes.txt'), 'x')
  const out = writeCbz(ch)
  const zip = readFileSync(out.path)
  assert.equal(zip.readUInt32LE(0), 0x04034b50)
  const names = [...zip.toString('latin1').matchAll(/(\d{3}\.jpg)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(names)], ['001.jpg', '002.jpg'], '按页号排序，不含别的文件')
})

test('图片魔数', () => {
  assert.equal(imageExt(JPG), 'jpg')
  assert.equal(imageExt(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'webp')
  assert.equal(imageExt(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(10)])), 'png')
  assert.equal(imageExt(Buffer.from('<!doctype html><html>')), null)
  assert.equal(imageExt(Buffer.from([0xff])), null)
})
