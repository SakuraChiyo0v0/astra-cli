import { defineDomain } from '../core/domain.ts'
import { heyboxCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'heybox',
  commands: heyboxCommands,
})
