import { defineDomain } from '../core/domain.ts'
import { deviceCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'device',
  commands: deviceCommands,
})
