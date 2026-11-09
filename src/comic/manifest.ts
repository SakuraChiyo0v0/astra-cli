import { defineDomain } from '../core/domain.ts'
import { registerAdoptIdentity } from '../core/db/library.ts'
import { comicCommands } from './commands.ts'
import { comicAdoptIdentity } from './sidecar.ts'

// lib adopt 认漫画页的身份（.astra-comic.json）。登记在这里，core 不用 import comic
registerAdoptIdentity(comicAdoptIdentity)

export const domain = defineDomain({
  name: 'comic',
  commands: comicCommands,
})
