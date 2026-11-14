import { defineDomain } from '../core/domain.ts'
import { mailCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'mail',
  commands: mailCommands,
})
