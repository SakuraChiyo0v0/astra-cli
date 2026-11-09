import { defineDomain } from '../core/domain.ts'
import { mangaCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'manga',
  // 借小说的繁简归一（搜索排序）和 zip 写入器（CBZ）
  dependsOn: ['novel'],
  commands: mangaCommands,
})
