import { defineDomain } from '../core/domain.ts'
import { scheduleCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'schedule',
  commands: scheduleCommands,
})
