/**
 * IMAP 客户端的协议解析：用假 socket 喂字节，验证「行 + 字面量」这套状态机。
 *
 * 真服务器只能验「能连上」，验不出字面量切分、多行响应、NO 分支这些细处；
 * 而这几处写错的表现是「验证码抽取神秘地少一半」或者挂住不返回，很难现场定位。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { ImapClient, imapDate } from '../src/mail/imap.ts'

/** 把脚本化的响应按命令出现顺序回放。 */
class FakeSocket extends EventEmitter {
  received: string[] = []
  destroyed = false
  private queue: string[]

  constructor(queue: string[]) {
    super()
    this.queue = queue
    // 连上后立刻给问候语
    setImmediate(() => this.emit('secureConnect'))
    setImmediate(() => this.push(this.queue.shift() ?? ''))
  }

  private push(chunk: string): void {
    if (chunk) this.emit('data', Buffer.from(chunk, 'latin1'))
  }

  write(data: string, cb?: (err?: Error | null) => void): void {
    this.received.push(data.replace(/\r\n$/, ''))
    const next = this.queue.shift()
    if (next) setImmediate(() => this.push(next))
    cb?.()
  }

  destroy(): void {
    this.destroyed = true
  }
}

class FakeClient extends ImapClient {
  readonly fake: FakeSocket

  constructor(queue: string[]) {
    super()
    this.fake = new FakeSocket(queue)
  }

  protected override createSocket(): never {
    return this.fake as never
  }
}

test('imap: 问候语 + 登录 + 搜索解析', async () => {
  const client = new FakeClient([
    '* OK [CAPABILITY IMAP4rev1] ready\r\n',
    'A1 OK LOGIN completed\r\n',
    '* 3 EXISTS\r\nA2 OK [READ-ONLY] SELECT completed\r\n',
    '* SEARCH 11 12 13\r\nA3 OK SEARCH completed\r\n',
  ])
  await client.connect({ host: 'fake' })
  await client.login('a@b.c', 'secret')
  const exists = await client.select('INBOX')
  assert.equal(exists, 3)
  const uids = await client.searchSince(new Date('2026-11-14T10:00:00+08:00'))
  assert.deepEqual(uids, ['11', '12', '13'])
  assert.equal(client.fake.received[0], 'A1 LOGIN "a@b.c" "secret"')
  assert.match(client.fake.received[2] ?? '', /^A3 UID SEARCH SINCE 14-Nov-2026$/)
})

test('imap: FETCH 的字面量（含正文里的 CRLF 与以 A4 开头的行）', async () => {
  const body = 'Subject: hi\r\n\r\nA4 OK look like a status line\r\ncode 123456\r\n'
  const bytes = Buffer.byteLength(body, 'latin1')
  const fetch = `* 1 FETCH (BODY[] {${bytes}}\r\n` + body + ')\r\nA3 OK FETCH completed\r\n'
  const client = new FakeClient(['* OK ready\r\n', 'A1 OK LOGIN completed\r\n', 'A2 OK SELECT completed\r\n', fetch])
  await client.connect({ host: 'fake' })
  await client.login('a@b.c', 'pw')
  await client.select('INBOX')
  const raw = await client.fetchRaw('12')
  assert.ok(raw)
  assert.match(raw.toString('latin1'), /code 123456/)
  assert.match(raw.toString('latin1'), /A4 OK look like a status line/)
})

test('imap: 命令被拒（NO/BAD）要报错而不是挂住', async () => {
  const client = new FakeClient([
    '* OK ready\r\n',
    'A1 NO [AUTHENTICATIONFAILED] Invalid credentials\r\n',
  ])
  await client.connect({ host: 'fake' })
  await assert.rejects(() => client.login('a@b.c', 'bad'), /IMAP 登录被拒绝/)
})

test('imap: 日期格式是 RFC 3501 的 14-Nov-2026', () => {
  assert.equal(imapDate(new Date('2026-11-04T12:00:00+08:00')), '04-Nov-2026')
})
