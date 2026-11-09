import { defineDomain } from '../core/domain.ts'
import { archiveCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'archive',
  commands: archiveCommands,
})
