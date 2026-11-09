import { defineDomain } from '../core/domain.ts'
import { pixivCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'pixiv',
  commands: pixivCommands,
})
