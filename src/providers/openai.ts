import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions.js';
import { LLMProvider } from './base.js';
import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  ToolCall,
  ToolDefinition,
} from '../core/types.js';
import { logger } from '../core/logger.js';

export class OpenAIProvider extends LLMProvider {
  readonly id: string;
  readonly type = 'openai';

  private client: OpenAI;
  private models: string[];

  constructor(id: string, opts: { apiKey: string; models?: string[] }) {
    super();
    this.id = id;
    this.client = new OpenAI({ apiKey: opts.apiKey });
    this.models = opts.models ?? ['gpt-4o', 'gpt-4o-mini'];
  }

  protected async chatImpl(request: ChatRequest): Promise<ChatResponse> {
    try {
      const messages = request.messages.map(toOpenAIMessage);
      const tools = request.tools?.length
        ? this.normalizeTools(request.tools) as ChatCompletionTool[]
        : undefined;

      const response = await this.client.chat.completions.create({
        model: request.model ?? this.models[0],
        messages,
        tools,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        ...(request.reasoning ? { reasoning: request.reasoning } : {}),
      });

      const choice = response.choices[0];
      const msg = choice.message;

      const toolCalls: ToolCall[] | undefined = msg.tool_calls
        ?.filter((tc): tc is Extract<typeof tc, { type: 'function' }> => tc.type === 'function')
        .map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: safeParse(tc.function.arguments),
        }));

      const reasoning = (msg as unknown as Record<string, unknown>).reasoning as string | undefined;

      return {
        content: msg.content ?? null,
        reasoning: reasoning || null,
        toolCalls: toolCalls?.length ? toolCalls : undefined,
        usage: response.usage
          ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
          : undefined,
        finishReason: mapFinishReason(choice.finish_reason),
      };
    } catch (err) {
      logger.error('OpenAIProvider', `Chat failed: ${(err as Error).message}`);
      throw err;
    }
  }

  async listModels(): Promise<string[]> {
    return [...this.models];
  }

  supportsToolCalling(): boolean {
    return true;
  }

  protected override normalizeTools(tools: ToolDefinition[]): ChatCompletionTool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
}

const VALID_TOOL_ID_RE = /^call_[a-zA-Z0-9]{8,}$/;

function sanitizeToolCallId(id: string): string {
  if (!id) return `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  if (VALID_TOOL_ID_RE.test(id)) return id;
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return `call_${(hash >>> 0).toString(36)}${id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`;
}

function toOpenAIMessage(msg: ChatMessage): ChatCompletionMessageParam {
  if (msg.role === 'tool') {
    return {
      role: 'tool',
      content: msg.content ?? '',
      tool_call_id: sanitizeToolCallId(msg.toolCallId ?? ''),
    };
  }

  if (msg.role === 'assistant' && msg.toolCalls?.length) {
    return {
      role: 'assistant',
      content: msg.content ?? null,
      tool_calls: msg.toolCalls.map((tc) => ({
        id: sanitizeToolCallId(tc.id),
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      })),
    };
  }

  if (msg.role === 'user' && msg.multimodal?.length) {
    const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail: string } }> = [];
    for (const p of msg.multimodal) {
      if (p.type === 'text' && p.text) {
        parts.push({ type: 'text', text: p.text });
      } else if (p.type === 'image' && p.imageBase64) {
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${p.mimeType || 'image/jpeg'};base64,${p.imageBase64}`,
            detail: 'auto',
          },
        });
      }
    }
    if (parts.length > 0) {
      return { role: 'user', content: parts as any };
    }
  }

  return {
    role: msg.role as 'user' | 'assistant' | 'system',
    content: msg.content ?? '',
  };
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { _raw: json };
  }
}

function mapFinishReason(
  reason: string | null,
): ChatResponse['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    default:
      return 'stop';
  }
}
