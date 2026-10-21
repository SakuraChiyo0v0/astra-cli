/**
 * 统一错误。
 *
 * `code` 给 AI 做分支判断，`message` 给人看，`hint` 直接告诉 AI 下一步该干什么。
 * 退出码只分几大类，细节看 code：
 *   1 未分类 / 2 参数错 / 3 需要配置或登录 / 4 没找到 / 5 上游或网络失败 / 130 取消
 */
export type ExitCode = 1 | 2 | 3 | 4 | 5 | 130

export class AstraError extends Error {
  readonly code: string
  readonly exitCode: ExitCode
  readonly hint: string | null
  readonly retryable: boolean
  readonly details: unknown

  constructor(
    code: string,
    message: string,
    options: { exitCode?: ExitCode; hint?: string; retryable?: boolean; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AstraError'
    this.code = code
    this.exitCode = options.exitCode ?? 1
    this.hint = options.hint ?? null
    this.retryable = options.retryable ?? false
    this.details = options.details
  }
}

export function invalidInput(message: string, hint?: string): AstraError {
  return new AstraError('INVALID_INPUT', message, { exitCode: 2, ...(hint === undefined ? {} : { hint }) })
}

export function toAstraError(err: unknown): AstraError {
  if (err instanceof AstraError) return err
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return new AstraError('TIMEOUT', `操作超时：${err.message}`, { exitCode: 5, retryable: true, cause: err })
  }
  const message = err instanceof Error ? err.message : String(err)
  return new AstraError('INTERNAL', message, { exitCode: 1, cause: err })
}
