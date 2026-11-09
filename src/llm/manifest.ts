import { defineDomain } from '../core/domain.ts'
import { llmCommands } from './commands.ts'

export const domain = defineDomain({
  name: 'llm',
  commands: llmCommands,
})
