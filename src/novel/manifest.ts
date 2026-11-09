import { defineDomain } from '../core/domain.ts'
import { novelCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'novel',
  commands: novelCommands,
})
