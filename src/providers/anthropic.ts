import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  Tool,
  ContentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages.js';
import { LLMProvider } from './base.js';
import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  ToolCall,
  ToolDefinition,
} from '../core/types.js';
import { logger } from '../core/logger.js';

export class AnthropicProvider extends LLMProvider {
  readonly id: string;
  readonly type = 'anthropic';

  private client: Anthropic;
  private models: string[];

  constructor(id: string, opts: { apiKey: string; models?: string[] }) {
    super();
    this.id = id;
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.models = opts.models ?? ['claude-sonnet-4-20250514'];
  }

  protected async chatImpl(request: ChatRequest): Promise<ChatResponse> {
    try {
      const systemText = extractSystem(request.messages);
      const messages = request.messages
        .filter((m) => m.role !== 'system')
        .map(toAnthropicMessage);

      const tools = request.tools?.length
        ? (this.normalizeTools(request.tools) as Tool[])
        : undefined;

      const response = await this.client.messages.create({
        model: request.model ?? this.models[0],
        max_tokens: request.maxTokens ?? 16384,
        ...(systemText ? { system: systemText } : {}),
        messages,
        ...(tools?.length ? { tools } : {}),
        ...(request.temperature != null ? { temperature: request.temperature } : {}),
      });

      let content: string | null = null;
      const toolCalls: ToolCall[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          content = (content ?? '') + block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: (block.input ?? {}) as Record<string, unknown>,
          });
        }
      }

      return {
        content,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        usage: {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        },
        finishReason: mapStopReason(response.stop_reason),
      };
    } catch (err) {
      logger.error('AnthropicProvider', `Chat failed: ${(err as Error).message}`);
      throw err;
    }
  }

  async listModels(): Promise<string[]> {
    return [...this.models];
  }

  supportsToolCalling(): boolean {
    return true;
  }

  protected override normalizeTools(tools: ToolDefinition[]): Tool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object' as const,
        ...t.parameters,
      },
    }));
  }
}

function extractSystem(messages: ChatMessage[]): string | undefined {
  const parts = messages
    .filter((m) => m.role === 'system' && m.content)
    .map((m) => m.content!);
  return parts.length ? parts.join('\n\n') : undefined;
}

function toAnthropicMessage(msg: ChatMessage): MessageParam {
  if (msg.role === 'assistant' && msg.toolCalls?.length) {
    const content: ContentBlockParam[] = [];
    if (msg.content) {
      content.push({ type: 'text', text: msg.content });
    }
    for (const tc of msg.toolCalls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.arguments,
      });
    }
    return { role: 'assistant', content };
  }

  if (msg.role === 'tool') {
    const block: ToolResultBlockParam = {
      type: 'tool_result',
      tool_use_id: msg.toolCallId ?? '',
      content: msg.content ?? '',
    };
    return { role: 'user', content: [block] };
  }

  if (msg.role === 'user' && msg.multimodal?.length) {
    const parts: ContentBlockParam[] = [];
    for (const p of msg.multimodal) {
      if (p.type === 'text' && p.text) {
        parts.push({ type: 'text', text: p.text });
      } else if (p.type === 'image' && p.imageBase64) {
        parts.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: (p.mimeType || 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: p.imageBase64,
          },
        });
      }
    }
    if (parts.length > 0) {
      return { role: 'user', content: parts };
    }
  }

  const role = msg.role === 'assistant' ? 'assistant' : 'user';
  return { role, content: msg.content ?? '' };
}

function mapStopReason(
  reason: string | null,
): ChatResponse['finishReason'] {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    default:
      return 'stop';
  }
}
