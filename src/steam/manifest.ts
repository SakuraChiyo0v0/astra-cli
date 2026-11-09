import { defineDomain } from '../core/domain.ts'
import { steamCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'steam',
  commands: steamCommands,
})
