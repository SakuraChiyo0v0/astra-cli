import { defineDomain } from '../core/domain.ts'
import { lolCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'lol',
  commands: lolCommands,
})
