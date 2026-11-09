import { defineDomain } from '../core/domain.ts'
import { vrCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'vr',
  commands: vrCommands,
})
