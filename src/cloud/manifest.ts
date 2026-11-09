import { defineDomain } from '../core/domain.ts'
import { cloudCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'cloud',
  dependsOn: ['quark'],
  commands: cloudCommands,
})
