import { defineDomain } from '../core/domain.ts'
import { xCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'x',
  commands: xCommands,
})
