import { defineDomain } from '../core/domain.ts'
import { musicCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'music',
  commands: musicCommands,
})
