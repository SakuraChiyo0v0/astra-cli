/**
 * EPUB3 打包（同时带 NCX，老阅读器也能出目录）。
 *
 * 输入是已经整理好的书：章节标题、段落、插图字节。这里不碰网络。
 */
import { createHash } from 'node:crypto'
import { buildZip, type ZipEntry } from './zip.ts'

export interface EpubImage {
  data: Buffer
  /** image/jpeg / image/png */
  mediaType: string
}

export interface EpubChapter {
  title: string
  paragraphs: string[]
  images: EpubImage[]
}

export interface EpubBook {
  /** 稳定标识（同一本书每次打包一样），用来生成 dc:identifier。 */
  identifier: string
  title: string
  author: string | null
  language: string
  cover: EpubImage | null
  chapters: EpubChapter[]
  /** 写进 dc:source 的原始地址。 */
  source?: string | null
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // XML 1.0 不允许的控制字符（站点正文里偶尔混进来，会让整本书解析失败）
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

function ext(mediaType: string): string {
  return mediaType === 'image/png' ? 'png' : mediaType === 'image/gif' ? 'gif' : 'jpg'
}

/** 由标识算一个固定的 UUID 形状字符串，重复打包结果一致。 */
function uuidFrom(identifier: string): string {
  const h = createHash('sha1').update(identifier).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function xhtml(title: string, body: string, lang: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head><meta charset="utf-8"/><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${body}
</body>
</html>
`
}

const STYLE = `body { margin: 0 5%; line-height: 1.7; }
h2 { text-align: center; margin: 1.5em 0 1em; }
p { text-indent: 2em; margin: 0.3em 0; }
div.img { text-align: center; margin: 1em 0; page-break-inside: avoid; }
div.img img { max-width: 100%; }
`

export function buildEpub(book: EpubBook): Buffer {
  const lang = book.language
  const uid = `urn:uuid:${uuidFrom(book.identifier)}`
  const files: ZipEntry[] = [{ name: 'mimetype', data: Buffer.from('application/epub+zip'), store: true }]
  const add = (name: string, content: string | Buffer): void => {
    files.push({ name, data: typeof content === 'string' ? Buffer.from(content, 'utf8') : content })
  }

  add('META-INF/container.xml', `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`)
  add('OEBPS/style.css', STYLE)

  const manifest: string[] = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="style" href="style.css" media-type="text/css"/>',
  ]
  const spine: string[] = []

  if (book.cover) {
    const name = `cover.${ext(book.cover.mediaType)}`
    add(`OEBPS/images/${name}`, book.cover.data)
    manifest.push(`<item id="cover-image" href="images/${name}" media-type="${book.cover.mediaType}" properties="cover-image"/>`)
    add('OEBPS/cover.xhtml', xhtml(book.title, `<div class="img"><img src="images/${name}" alt="${escapeXml(book.title)}"/></div>`, lang))
    manifest.push('<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>')
    spine.push('<itemref idref="cover"/>')
  }

  const toc: { title: string; href: string }[] = []
  book.chapters.forEach((chapter, i) => {
    const n = String(i + 1).padStart(4, '0')
    const body = [`<h2>${escapeXml(chapter.title)}</h2>`, ...chapter.paragraphs.map((p) => `<p>${escapeXml(p)}</p>`)]
    chapter.images.forEach((img, j) => {
      const name = `c${n}_${j + 1}.${ext(img.mediaType)}`
      add(`OEBPS/images/${name}`, img.data)
      manifest.push(`<item id="img-${n}-${j + 1}" href="images/${name}" media-type="${img.mediaType}"/>`)
      body.push(`<div class="img"><img src="images/${name}" alt="${escapeXml(chapter.title)} ${j + 1}"/></div>`)
    })
    const href = `c${n}.xhtml`
    add(`OEBPS/${href}`, xhtml(chapter.title, body.join('\n'), lang))
    manifest.push(`<item id="c${n}" href="${href}" media-type="application/xhtml+xml"/>`)
    spine.push(`<itemref idref="c${n}"/>`)
    toc.push({ title: chapter.title, href })
  })

  add('OEBPS/nav.xhtml', xhtml('目录', `<nav epub:type="toc" id="toc"><h2>目录</h2><ol>
${toc.map((t) => `<li><a href="${t.href}">${escapeXml(t.title)}</a></li>`).join('\n')}
</ol></nav>`, lang))

  add('OEBPS/toc.ncx', `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${uid}"/></head>
<docTitle><text>${escapeXml(book.title)}</text></docTitle>
<navMap>
${toc.map((t, i) => `<navPoint id="p${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeXml(t.title)}</text></navLabel><content src="${t.href}"/></navPoint>`).join('\n')}
</navMap>
</ncx>
`)

  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  add('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:identifier id="uid">${uid}</dc:identifier>
  <dc:title>${escapeXml(book.title)}</dc:title>
  <dc:language>${lang}</dc:language>
${book.author ? `  <dc:creator>${escapeXml(book.author)}</dc:creator>\n` : ''}${book.source ? `  <dc:source>${escapeXml(book.source)}</dc:source>\n` : ''}  <meta property="dcterms:modified">${modified}</meta>
${book.cover ? '  <meta name="cover" content="cover-image"/>\n' : ''}</metadata>
<manifest>
${manifest.map((m) => `  ${m}`).join('\n')}
</manifest>
<spine toc="ncx">
${spine.map((s) => `  ${s}`).join('\n')}
</spine>
</package>
`)

  return buildZip(files)
}
