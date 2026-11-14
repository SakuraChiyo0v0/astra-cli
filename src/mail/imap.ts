/**
 * 最小 IMAP 客户端：只做「登录 → 选目录 → 按日期搜 → 取整封」这四件事。
 *
 * ## 为什么自己写而不引第三方
 *
 * 需求太窄：要的只是「最近 N 分钟的邮件正文」，不涉及 IDLE、CONDSTORE、搜索语法、
 * 附件下载、多目录同步。三方库（imapflow 等）会拖进 MIME/流处理/DKIM 一整套，
 * 打包进单文件后体积和加载路径都变复杂，而这里全部用到的协议面只有 4 条命令。
 *
 * ## 协议要点（踩过的）
 *
 * - 响应是「行 + 字面量」混合：`* 1 FETCH (BODY[] {12345}` 后面紧跟 12345 字节原始数据，
 *   再下一行才收尾。只按行切会把正文切碎，所以读到行尾的 `{N}` 就必须原样吞掉 N 字节
 * - **只读**：全部用 `BODY.PEEK[]`，取信不会把邮件标成已读（`BODY[]` 会）
 * - 命令完成以 `<tag> OK/NO/BAD` 为界，中间的数据行与字面量都不代表成���
 * - 只有 993 隐式 TLS 一条路径（QQ/163/Gmail/Outlook 都支持），不做明文与 STARTTLS
 */
import tls from 'node:tls'
import { AstraError } from '../core/errors.ts'

export interface ImapOptions {
  host: string
  port?: number
  timeoutMs?: number
}

interface Response {
  /** 数据行（含 `*` 开头那些）。 */
  lines: string[]
  /** 每个 `{N}` 字面量的原始字节，顺序与出现的行一致。 */
  literals: Buffer[]
  /** 最终状态行，例如 `A3 OK FETCH completed`。 */
  status: string
}

/** IMAP 的 quoted string：引号与反斜杠要转义。 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** IMAP 的日期格式：`14-Nov-2026`（月名是英文缩写，必须是这个写法）。 */
export function imapDate(d: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(d.getDate())}-${months[d.getMonth()]}-${d.getFullYear()}`
}

export class ImapClient {
  private socket: tls.TLSSocket | null = null
  private buf: Buffer = Buffer.alloc(0)
  private waiters: (() => void)[] = []
  private failure: Error | null = null
  private closed = false
  private tagSeq = 0

  /**
   * 建传输层。单独一个方法是为了让测试能换成假 socket —— 协议解析（行 + 字面量）
   * 才是容易写错的地方，靠真服务器验一轮不够快也验不全。
   */
  protected createSocket(opts: ImapOptions): tls.TLSSocket {
    return tls.connect({
      host: opts.host,
      port: opts.port ?? 993,
      servername: opts.host,
      rejectUnauthorized: true,
    })
  }

  async connect(opts: ImapOptions): Promise<void> {
    const port = opts.port ?? 993
    const timeout = opts.timeoutMs ?? 20_000
    this.socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const socket = this.createSocket(opts)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new AstraError('IMAP_TIMEOUT', `连接 ${opts.host}:${port} 超时`, { exitCode: 5, retryable: true }))
      }, timeout)
      socket.once('secureConnect', () => {
        clearTimeout(timer)
        resolve(socket)
      })
      socket.once('error', (err) => {
        clearTimeout(timer)
        reject(
          new AstraError('IMAP_CONNECT_FAILED', `连不上 ${opts.host}:${port}：${err.message}`, {
            exitCode: 5,
            retryable: true,
            hint: '确认网络能到 IMAP 主机、端口 993 没被挡；Gmail/Outlook 在国内需要代理',
          }),
        )
      })
    })
    this.socket.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk])
      this.wake()
    })
    const fail = (err: Error) => {
      this.failure = err
      this.wake()
    }
    this.socket.on('error', fail)
    this.socket.on('close', () => {
      this.closed = true
      this.wake()
    })
    const greeting = await this.readLine()
    if (!/^\* (OK|PREAUTH)/i.test(greeting)) {
      throw new AstraError('IMAP_GREETING_FAILED', `IMAP 问候异常：${greeting}`, { exitCode: 5 })
    }
  }

  private wake(): void {
    const list = this.waiters
    this.waiters = []
    for (const fn of list) fn()
  }

  private async waitForData(): Promise<void> {
    if (this.failure) throw this.failure
    if (this.closed) throw new AstraError('IMAP_CLOSED', 'IMAP 连接已断开', { exitCode: 5, retryable: true })
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const idx = this.buf.indexOf('\r\n')
      if (idx >= 0) {
        const line = this.buf.subarray(0, idx).toString('utf8')
        this.buf = this.buf.subarray(idx + 2)
        return line
      }
      await this.waitForData()
    }
  }

  private async readBytes(n: number): Promise<Buffer> {
    while (this.buf.length < n) await this.waitForData()
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return Buffer.from(out)
  }

  private async write(text: string): Promise<void> {
    const socket = this.socket
    if (!socket) throw new AstraError('IMAP_CLOSED', 'IMAP 还没连上', { exitCode: 5 })
    await new Promise<void>((resolve, reject) => {
      socket.write(text, (err) => (err ? reject(err) : resolve()))
    })
  }

  /** 发一条命令并读到它的状态行为止；中间的 `{N}` 字面量按长度吞掉。 */
  private async command(cmd: string): Promise<Response> {
    const tag = `A${++this.tagSeq}`
    await this.write(`${tag} ${cmd}\r\n`)
    const lines: string[] = []
    const literals: Buffer[] = []
    for (;;) {
      const line = await this.readLine()
      const literal = /\{(\d+)\}$/.exec(line)
      if (literal) {
        lines.push(line)
        literals.push(await this.readBytes(Number(literal[1])))
        continue
      }
      if (line.startsWith(`${tag} `)) {
        const status = line.slice(tag.length + 1)
        if (!/^OK/i.test(status.trim())) {
          throw new AstraError('IMAP_COMMAND_FAILED', `IMAP 拒绝执行：${status}`, {
            exitCode: 5,
            details: { command: cmd },
          })
        }
        return { lines, literals, status }
      }
      lines.push(line)
    }
  }

  async login(user: string, password: string): Promise<void> {
    try {
      await this.command(`LOGIN ${quote(user)} ${quote(password)}`)
    } catch (err) {
      throw new AstraError('IMAP_LOGIN_FAILED', 'IMAP 登录被拒绝', {
        exitCode: 3,
        hint: 'QQ/163 要填「授权码」而不是登录密码（邮箱设置 → 账户 → 开启 IMAP → 生成授权码）',
        cause: err,
      })
    }
  }

  async select(folder: string): Promise<number> {
    const res = await this.command(`SELECT ${quote(folder)}`)
    for (const line of res.lines) {
      const m = /^\* (\d+) EXISTS/i.exec(line)
      if (m) return Number(m[1])
    }
    return 0
  }

  /** 按「不早于某天」搜索，返回 uid 列表（升序）。IMAP 的 SINCE 只到日，细筛交给调用方。 */
  async searchSince(when: Date): Promise<string[]> {
    const res = await this.command(`UID SEARCH SINCE ${imapDate(when)}`)
    const uids: string[] = []
    for (const line of res.lines) {
      if (!/^\* SEARCH/i.test(line)) continue
      const parts = line.slice('* SEARCH'.length).trim().split(/\s+/).filter(Boolean)
      uids.push(...parts)
    }
    return uids
  }

  /** 取整封原始邮件（`BODY.PEEK[]`，不会把信标成已读）。 */
  async fetchRaw(uid: string): Promise<Buffer | null> {
    const res = await this.command(`UID FETCH ${uid} (BODY.PEEK[])`)
    return res.literals[0] ?? null
  }

  async noop(): Promise<void> {
    await this.command('NOOP')
  }

  async close(): Promise<void> {
    if (!this.socket) return
    try {
      await this.command('LOGOUT')
    } catch {
      /* 退出失败无所谓，下面强制断开 */
    }
    this.socket.destroy()
    this.socket = null
  }
}
