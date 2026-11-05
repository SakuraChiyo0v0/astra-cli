/**
 * 通用 LLM 端点：一套 OpenAI 兼容接口的配置。
 *
 * 只存端点，不存业务：文本 / 文生图 / 图生图都按 OpenAI 的标准字段发，
 * 各家差异（模型名、size 档位）交给配置和调用参数，不在代码里写死厂商判断。
 */

export interface LlmModels {
  /** 文本对话模型，如 gpt-4o-mini */
  chat?: string
  /** 文生图模型，如 gpt-image-1 */
  image?: string
  /** 图生图 / 编辑模型，缺省回落到 image */
  edit?: string
}

export interface LlmProvider {
  name: string
  /** 形如 https://host/v1（不带尾部斜杠） */
  baseUrl: string
  /** 明文只落盘（600），任何输出都走 maskKey() */
  apiKey: string
  models: LlmModels
  addedAt: string
}

export interface LlmStore {
  version: 1
  default?: string
  providers: Record<string, LlmProvider>
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
