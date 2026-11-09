import { defineDomain } from '../core/domain.ts'
import { douyinCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'douyin',
  commands: douyinCommands,
})
