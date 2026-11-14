/**
 * 从一封邮件（主题 + 正文）里抽验证码。
 *
 * 策略（按可靠性从高到低）：
 *  1. 找含「验证码 / verification code / security code」的行，连同**后面 3 行**一起扫
 *     —— 中文邮件常把码单独放一行，只在关键词行里找会漏（Steam 客服支援码就是这样）
 *  2. 全文找 6 位数字（绝大多数验证码就是这个形状）
 *  3. 只找到 4~8 位数字时也用，但排在 6 位之后
 *  4. 字母数字混合码（`Q7XK9F`），必须同时含数字和字母，且只在关键词附近找，
 *     否则订单号、快递单号这类也会被当成码
 *
 * 明确**不抽**：长数字串（订单号/金额/时间戳）——纯数字分支用前后边界卡住位数。
 */

const HINT_WORDS = [
  '验证码',
  '校验码',
  '动态码',
  '一次性',
  '确认码',
  '验证代码',
  '安全码',
  '支援碼',
  'verification code',
  'your code',
  'security code',
  'passcode',
  'one-time',
  'otp',
]

const CODE_6 = /(?<!\d)(\d{6})(?!\d)/
const CODE_ANY = /(?<!\d)(\d{4,8})(?!\d)/
const ALNUM = /(?<![A-Za-z0-9])([A-Z0-9]{5,8})(?![A-Za-z0-9])/g

function looksLikeCode(candidate: string): boolean {
  return /[0-9]/.test(candidate) && /[A-Z]/.test(candidate)
}

export function extractCode(subject: string, body: string): string {
  const lines = `${subject}\n${body}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)

  for (let i = 0; i < lines.length; i += 1) {
    const low = (lines[i] ?? '').toLowerCase()
    if (!HINT_WORDS.some((w) => low.includes(w))) continue
    for (const near of lines.slice(i, i + 4)) {
      const six = CODE_6.exec(near) ?? CODE_ANY.exec(near)
      if (six?.[1]) return six[1]
      for (const match of near.matchAll(ALNUM)) {
        const candidate = match[1] ?? ''
        if (looksLikeCode(candidate)) return candidate
      }
    }
  }

  const six = CODE_6.exec(body) ?? CODE_6.exec(subject)
  if (six?.[1]) return six[1]
  const loose = CODE_ANY.exec(body)
  return loose?.[1] ?? ''
}

/** 摘要里显示用：把连续空白压成一个空格。 */
export function oneLine(text: string, limit = 160): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, limit)
}
