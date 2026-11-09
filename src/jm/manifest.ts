import { defineDomain } from '../core/domain.ts'
import { registerAdoptIdentity } from '../core/db/library.ts'
import { jmCommands } from './commands.ts'
import { jmAdoptIdentity } from './sidecar.ts'

// lib adopt 认漫画页的身份（.astra-jm.json）。登记在这里，core 不用 import jm
registerAdoptIdentity(jmAdoptIdentity)

export const domain = defineDomain({
  name: 'jm',
  commands: jmCommands,
})
