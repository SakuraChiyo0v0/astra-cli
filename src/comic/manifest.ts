import { defineDomain, type DoctorContext } from '../core/domain.ts'
import { comicCommands } from './commands.ts'
import { comicAdoptIdentity } from './sidecar.ts'
import { comicRoot } from './paths.ts'

async function doctor({ add, checkWritable, ensureExists, watchDisk }: DoctorContext): Promise<void> {
  const comic = comicRoot()
  try {
    ensureExists(comic)
    const write = checkWritable(comic)
    add({ name: 'comic_dir', kind: 'domain', ok: write.ok, detail: write.detail, ...(write.ok ? {} : { hint: '检查 comic.dir / ASTRA_COMIC_DIR 权限' }) })
  } catch (err) {
    add({ name: 'comic_dir', kind: 'domain', ok: false, detail: `建不出目录：${(err as Error).message.slice(0, 100)}` })
  }
  watchDisk('comic_disk', comic)
}

export const domain = defineDomain({
  name: 'comic',
  commands: comicCommands,
  doctor,
  // lib adopt 认漫画页的身份（.astra-comic.json）。声明在这里，core 不用 import comic
  adoptIdentity: comicAdoptIdentity,
})
