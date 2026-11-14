/**
 * 邮箱账号的类型。
 *
 * 只存「授权码 / 应用专用密码」，不存登录密码 —— QQ/163/Gmail/Outlook 都要求用
 * 应用级凭据走 IMAP，账号的登录密码在这里根本用不上。
 */
export interface MailAccount {
  /** 名字（`qq`、`work`…），命令里用 `--account 名字` 指它。 */
  name: string
  host: string
  port: number
  user: string
  /** 授权码 / 应用专用密码。只在文件里出现明文，回显一律脱敏。 */
  password: string
  /** 要读的邮箱目录，默认 INBOX。 */
  folder: string
}

export interface MailStore {
  version: 1
  default?: string
  accounts: Record<string, MailAccount>
}

/** 一封邮件的摘要（不保留原始 MIME，省内存）。 */
export interface MailMessage {
  uid: string
  from: string
  subject: string
  /** 本地时间 `MM-DD HH:MM:SS`。 */
  date: string
  /** 抽到的验证码，没抽到就是空串。 */
  code: string
  /** 正文前 160 字，排障用。 */
  preview: string
}
