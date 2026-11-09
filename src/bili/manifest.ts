import { defineDomain } from '../core/domain.ts'
import { biliCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'bili',
  commands: biliCommands,
})
