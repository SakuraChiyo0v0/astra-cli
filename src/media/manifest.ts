import { defineDomain } from '../core/domain.ts'
import { mediaCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'media',
  dependsOn: ['device'],
  commands: mediaCommands,
})
