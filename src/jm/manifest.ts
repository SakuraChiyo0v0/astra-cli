import { defineDomain, type DoctorContext } from '../core/domain.ts'
import { jmCommands } from './commands.ts'
import { jmAdoptIdentity } from './sidecar.ts'
import { jmRoot } from './paths.ts'

async function doctor({ add, checkWritable, ensureExists, watchDisk }: DoctorContext): Promise<void> {
  const jm = jmRoot()
  try {
    ensureExists(jm)
    const write = checkWritable(jm)
    add({ name: 'jm_dir', kind: 'domain', ok: write.ok, detail: write.detail, ...(write.ok ? {} : { hint: '检查 jm.dir / ASTRA_JM_DIR 权限' }) })
  } catch (err) {
    add({ name: 'jm_dir', kind: 'domain', ok: false, detail: `建不出目录：${(err as Error).message.slice(0, 100)}` })
  }
  watchDisk('jm_disk', jm)
}

export const domain = defineDomain({
  name: 'jm',
  commands: jmCommands,
  doctor,
  // lib adopt 认本子页的身份（.astra-jm.json）。声明在这里，core 不用 import jm
  adoptIdentity: jmAdoptIdentity,
})
