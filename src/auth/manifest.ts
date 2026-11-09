import { defineDomain } from '../core/domain.ts'
import { authCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'auth',
  commands: authCommands,
})
