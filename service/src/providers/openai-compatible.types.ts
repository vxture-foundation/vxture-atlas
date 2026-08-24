/**
 * OpenAI 兼容协议的 tool_call 子结构
 */
export interface OpenAiToolCall {
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

/**
 * The usage object, as every OpenAI-dialect upstream reports it.
 *
 * The cost splits arrive under two spellings and Atlas accepts both: OpenAI
 * nests the cached count in `prompt_tokens_details.cached_tokens`, DeepSeek
 * ALSO puts it top-level as `prompt_cache_hit_tokens` (verified against the
 * live API 2026-08-24). `reasoning_tokens` is nested by both.
 */
export interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  /** DeepSeek's top-level spelling of the same fact. */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface OpenAiCompatibleChatResponse {
  id?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      /**
       * 思考型模型的思维链（DeepSeek V4、各家 reasoning 模型）。Atlas **不**把它
       * 当作正文，也还没有把它交付给调用方 —— 它在这里的唯一作用是让"正文为空"
       * 这条错误说得出成因。完整透传要先定 product_251 的字段位置，且带 tools
       * 的多轮对话上游要求原样回传，否则 400：TD-046。
       */
      reasoning_content?: string | null;
      tool_calls?: OpenAiToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAiUsage;
  error?: {
    code?: string;
    message?: string;
  };
}

/**
 * OpenAI 兼容协议的流式 chunk（chat.completion.chunk）
 */
export interface OpenAiCompatibleChatStreamChunk {
  id?: string;
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string | null;
      /** 同上，流式分片形态。当前解析器读取但不转发。 */
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAiUsage;
}
