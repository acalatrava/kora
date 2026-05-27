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
import fs from 'node:fs';

export type ToolCallProfile = 'standard' | 'qwen' | 'custom';

export class OpenAICompatProvider extends LLMProvider {
  readonly id: string;
  readonly type = 'openai_compat';

  private client: OpenAI;
  private models: string[];
  private toolCallProfile: ToolCallProfile;

  constructor(
    id: string,
    opts: {
      baseUrl: string;
      apiKey?: string;
      models?: string[];
      toolCallProfile?: ToolCallProfile;
    },
  ) {
    super();
    this.id = id;
    this.client = new OpenAI({
      baseURL: opts.baseUrl,
      apiKey: opts.apiKey ?? 'not-needed',
      timeout: 30 * 60 * 1000,
    });
    this.models = opts.models ?? [];
    this.toolCallProfile = opts.toolCallProfile ?? 'standard';
  }

  protected async chatImpl(request: ChatRequest): Promise<ChatResponse> {
    try {
      const messages = request.messages.map(toOpenAIMessage);
      const tools = request.tools?.length
        ? (this.normalizeTools(request.tools) as ChatCompletionTool[])
        : undefined;
      logger.debug('OpenAICompatProvider', JSON.stringify({
        baseURL: this.client.baseURL,
        model: request.model ?? this.models[0] ?? 'default',
      }, null, 2));
      const stream = await this.client.chat.completions.create({
        model: request.model ?? this.models[0] ?? 'default',
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(tools ? { tools } : {}),
        ...(request.maxTokens != null ? { max_tokens: request.maxTokens } : {}),
        ...(request.temperature != null ? { temperature: request.temperature } : {}),
        ...(request.reasoning ? { extra_body: { reasoning: request.reasoning } } : {}),
      });

      let content = '';
      let usage;
      const rawToolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
      let finishReason: string | null | undefined;

      for await (const chunk of stream) {
        if (chunk.usage) {
          usage = chunk.usage;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        finishReason = choice.finish_reason ?? finishReason;

        const delta = choice.delta;
        /*
        if (logger.currentLevel === 'debug') {
          console.log('delta:', delta);
          console.log('content:', content);
          console.log('finishReason:', finishReason);
          console.log('rawToolCalls:', rawToolCalls);
          console.log('usage:', usage);
          console.log('choice:', choice);
          console.log('stream:', stream);
          console.log('request:', request);
        }
        */

        if (delta?.content) {
          content += delta.content;
          // log the content to the console without new lines
          // if debug log is enabled
          if (logger.currentLevel === 'debug') {
            process.stdout.write(delta.content);
          }
        }

        if (delta?.tool_calls?.length) {
          for (const tc of delta.tool_calls) {
            const index = tc.index ?? 0;
            const current = rawToolCalls.get(index) ?? { arguments: '' };

            if (tc.id) current.id = tc.id;
            if (tc.function?.name) current.name = tc.function.name;
            if (tc.function?.arguments) current.arguments += tc.function.arguments;

            rawToolCalls.set(index, current);
          }
        }
      }

      let toolCalls: ToolCall[] | undefined;

      if (rawToolCalls.size) {
        toolCalls = [...rawToolCalls.values()]
          .filter((tc): tc is { id?: string; name?: string; arguments: string } => !!tc.name)
          .map((tc, i) => ({
            id: tc.id ?? `call_${Date.now().toString(36)}${i}`,
            name: tc.name!,
            arguments: safeParse(tc.arguments),
          }));
      } else if (this.toolCallProfile === 'qwen' && content) {
        const extracted = extractQwenToolCalls(content);
        if (extracted.length) {
          toolCalls = extracted;
        }
      }

      const msg = {
        role: 'assistant' as const,
        content,
        ...(toolCalls?.length
          ? {
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          }
          : {}),
      };

      const choice = {
        message: msg,
        finish_reason: finishReason ?? 'stop'
      };

      const hasToolCalls = toolCalls && toolCalls.length > 0;

      const reasoning = (msg as unknown as Record<string, unknown>).reasoning as string | undefined;

      return {
        content: hasToolCalls && !msg.content?.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim()
          ? null
          : msg.content ?? null,
        reasoning: reasoning || null,
        toolCalls: hasToolCalls ? toolCalls : undefined,
        usage: usage
          ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          }
          : undefined,
        finishReason: hasToolCalls
          ? 'tool_calls'
          : mapFinishReason(choice.finish_reason),
      };
    } catch (err: any) {
      logger.error('OpenAICompatProvider', `Chat failed: ${(err as Error).message}`);
      console.error('status:', err.status);
      console.error('message:', err.message);
      console.error('response data:', err.response?.data);
      console.error('error payload:', err.error);

      throw err;
    }
  }

  async listModels(): Promise<string[]> {
    if (this.models.length) return [...this.models];

    try {
      const list = await this.client.models.list();
      const ids: string[] = [];
      for await (const model of list) {
        ids.push(model.id);
      }
      return ids;
    } catch (err) {
      logger.warn('OpenAICompatProvider', `Failed to list models: ${(err as Error).message}`);
      return [];
    }
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

/**
 * Some Qwen models emit tool calls as XML-like blocks in their text output
 * instead of using the structured tool_calls field.
 */
function extractQwenToolCalls(content: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as { name?: string; arguments?: Record<string, unknown> };
      if (parsed.name) {
        calls.push({
          id: `call_qw${Date.now().toString(36)}${calls.length}`,
          name: parsed.name,
          arguments: parsed.arguments ?? {},
        });
      }
    } catch {
      logger.warn('OpenAICompatProvider', 'Failed to parse Qwen tool call block');
    }
  }

  return calls;
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
