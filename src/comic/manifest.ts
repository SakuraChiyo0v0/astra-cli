import { defineDomain } from '../core/domain.ts'
import { comicCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'comic',
  commands: comicCommands,
})
