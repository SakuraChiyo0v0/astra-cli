import { defineDomain } from '../core/domain.ts'
import { modelCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'model',
  commands: modelCommands,
})
