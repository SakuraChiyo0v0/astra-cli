import { defineDomain } from '../core/domain.ts'
import { quarkCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'quark',
  commands: quarkCommands,
})
