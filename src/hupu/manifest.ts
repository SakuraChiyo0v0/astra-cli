import { defineDomain } from '../core/domain.ts'
import { hupuCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'hupu',
  commands: hupuCommands,
})
