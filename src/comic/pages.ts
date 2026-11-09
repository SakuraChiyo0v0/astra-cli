/**
 * 落盘前的完整性：截断的图不算「已有」，也不会留在目录里。
 */
import { readFile, rm } from 'node:fs/promises'
import { AstraError } from '../core/errors.ts'
import { verifyImage } from '../core/imagecheck.ts'

/** 文件在、并且容器结构完整。读失败或校验失败都是 false。 */
export async function imageIntact(file: string): Promise<boolean> {
  try {
    return verifyImage(await readFile(file)).ok
  } catch {
    return false
  }
}

/**
 * 写一页并校验。不完整就删掉再写一次；两次都不行就抛 TRUNCATED，目录里不留半张图。
 * `write` 自己负责把字节写到 `target`（解混淆也算在里面）。
 */
export async function saveVerifiedPage(target: string, write: () => Promise<void>): Promise<void> {
  let last: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await write()
      const check = verifyImage(await readFile(target))
      if (check.ok) return
      await rm(target, { force: true })
      last = new AstraError('TRUNCATED', `图片不完整（${check.reason ?? '未知原因'}）`, {
        exitCode: 5,
        retryable: true,
        hint: '稍后重试这一话；截断的图不会留在目录里',
      })
    } catch (err) {
      await rm(target, { force: true }).catch(() => {})
      last = err
      const code = err instanceof AstraError ? err.code : ''
      const retry = !(err instanceof AstraError) || code === 'FFMPEG_FAILED' || code === 'COMIC_BAD_IMAGE' || code === 'TRUNCATED'
      if (!retry) throw err
    }
  }
  throw last
}
