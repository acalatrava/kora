import { logger } from './logger.js';
import type { ChatMessage, ToolDefinition } from './types.js';

const SCOPE = 'context-compactor';
const CHARS_PER_TOKEN = 3.5;
const MAX_TOOL_RESULT_TOKENS = 4000;
const MAX_SUMMARIZE_TOKENS = 30000;
const KEEP_TIERS = [50, 25, 10, 4];

function msgTokens(msg: ChatMessage): number {
  let chars = msg.content?.length ?? 0;
  if (msg.toolCalls) chars += JSON.stringify(msg.toolCalls).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateTokens(messages: ChatMessage[], tools?: ToolDefinition[]): number {
  let total = 0;
  for (const msg of messages) total += msgTokens(msg);
  if (tools?.length) total += Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN);
  return total;
}

export interface CompactionResult {
  messages: ChatMessage[];
  removed: number;
  beforeTokens: number;
  afterTokens: number;
}

const COMPACTION_PROMPT =
  'Summarize the conversation history so far in a concise but thorough way. ' +
  'Preserve: key facts, user preferences, decisions made, tool results, pending tasks, and important context. ' +
  'Format as a structured summary. This will replace the older messages to save context space.';

function truncateLargeToolResults(msgs: ChatMessage[], maxResultTokens: number): ChatMessage[] {
  return msgs.map(m => {
    if (m.role === 'tool' && m.content) {
      const tokens = Math.ceil(m.content.length / CHARS_PER_TOKEN);
      if (tokens > maxResultTokens) {
        const maxChars = Math.floor(maxResultTokens * CHARS_PER_TOKEN);
        const half = Math.floor(maxChars / 2);
        return {
          ...m,
          content: m.content.slice(0, half) + '\n\n[... truncated ...]\n\n' + m.content.slice(-half),
        };
      }
    }
    return m;
  });
}

/**
 * Finds a safe split point that doesn't break tool_call / tool_result pairs.
 * Walks backwards from the candidate index to avoid orphaned tool messages.
 */
function findSafeSplitIndex(nonSystem: ChatMessage[], targetKeepCount: number): number {
  const keep = Math.min(targetKeepCount, nonSystem.length);
  let splitIdx = nonSystem.length - keep;

  while (splitIdx > 0 && splitIdx < nonSystem.length) {
    const msg = nonSystem[splitIdx];
    if (msg.role === 'tool') {
      splitIdx--;
    } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
      splitIdx--;
    } else {
      break;
    }
  }
  return Math.max(splitIdx, 0);
}

function buildResult(
  system: ChatMessage | undefined,
  summaryContent: string,
  toKeep: ChatMessage[],
  tools: ToolDefinition[],
  beforeTokens: number,
  removed: number,
): CompactionResult {
  const compacted: ChatMessage[] = [];
  if (system) compacted.push(system);
  compacted.push({
    role: 'user',
    content: summaryContent,
  });
  compacted.push({
    role: 'assistant',
    content: 'Understood. I have the context from our earlier conversation. How can I help?',
  });
  compacted.push(...toKeep);
  const afterTokens = estimateTokens(compacted, tools);
  return { messages: compacted, removed, beforeTokens, afterTokens };
}

/**
 * Caps messages to summarize so the LLM call doesn't exceed context limits.
 * Keeps the most recent ones (closest to the kept messages) and drops the oldest.
 */
function capForSummarization(msgs: ChatMessage[]): ChatMessage[] {
  const total = estimateTokens(msgs);
  if (total <= MAX_SUMMARIZE_TOKENS) return msgs;

  let accum = 0;
  let startIdx = msgs.length;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const mt = msgTokens(msgs[i]);
    if (accum + mt > MAX_SUMMARIZE_TOKENS) break;
    accum += mt;
    startIdx = i;
  }
  const capped = msgs.slice(startIdx);
  const dropped = msgs.length - capped.length;
  if (dropped > 0) {
    logger.info(SCOPE, `Capped summarization input: dropped ${dropped} oldest messages (${total} → ${accum} tokens)`);
  }
  return capped;
}

async function trySummarize(
  toSummarize: ChatMessage[],
  llmCall: (msgs: ChatMessage[]) => Promise<string>,
): Promise<string | null> {
  let capped = capForSummarization(toSummarize);
  capped = truncateLargeToolResults(capped, MAX_TOOL_RESULT_TOKENS);

  const summaryMessages: ChatMessage[] = [
    { role: 'system', content: COMPACTION_PROMPT },
    ...capped,
    { role: 'user', content: 'Now provide a structured summary of the conversation above.' },
  ];

  try {
    return await llmCall(summaryMessages);
  } catch (err) {
    logger.error(SCOPE, `LLM summarization failed: ${(err as Error).message}`);
    return null;
  }
}

export async function compactMessages(
  messages: ChatMessage[],
  maxTokens: number,
  tools: ToolDefinition[],
  llmCall: (msgs: ChatMessage[]) => Promise<string>,
): Promise<CompactionResult> {
  const beforeTokens = estimateTokens(messages, tools);

  if (beforeTokens <= maxTokens) {
    return { messages, removed: 0, beforeTokens, afterTokens: beforeTokens };
  }

  logger.info(SCOPE, `Context compaction triggered: ${beforeTokens} tokens > ${maxTokens} limit`);

  const system = messages.find(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');

  // --- Phase 1: truncate large tool results ---
  const truncated = truncateLargeToolResults(nonSystem, MAX_TOOL_RESULT_TOKENS);
  const phase1 = system ? [system, ...truncated] : [...truncated];
  const phase1Tokens = estimateTokens(phase1, tools);

  if (phase1Tokens <= maxTokens) {
    logger.info(SCOPE, `Phase 1 (truncate tool results): ${beforeTokens} → ${phase1Tokens} tokens`);
    return { messages: phase1, removed: 0, beforeTokens, afterTokens: phase1Tokens };
  }

  logger.info(SCOPE, `Phase 1 not enough (${phase1Tokens} tokens). Proceeding to iterative summarization.`);

  // --- Phase 2: iterative summarization with decreasing keep tiers ---
  for (const tier of KEEP_TIERS) {
    if (tier >= truncated.length) continue;

    const splitIdx = findSafeSplitIndex(truncated, tier);
    if (splitIdx < 2) continue;

    const toKeep = truncated.slice(splitIdx);
    const toSummarize = truncated.slice(0, splitIdx);

    logger.info(SCOPE, `Trying tier ${tier}: keep ${toKeep.length} messages, summarize ${toSummarize.length}`);

    const summary = await trySummarize(toSummarize, llmCall);

    if (summary) {
      const result = buildResult(
        system,
        `[Context Summary — ${toSummarize.length} earlier messages condensed]\n\n${summary}`,
        toKeep,
        tools,
        beforeTokens,
        toSummarize.length,
      );
      if (result.afterTokens <= maxTokens) {
        logger.info(SCOPE, `Tier ${tier} success: ${beforeTokens} → ${result.afterTokens} tokens (kept ${toKeep.length}, removed ${toSummarize.length})`);
        return result;
      }
      logger.info(SCOPE, `Tier ${tier} still too large (${result.afterTokens} tokens), trying next tier`);
    } else {
      logger.warn(SCOPE, `Tier ${tier} summarization failed, trying next tier`);
    }
  }

  // --- Phase 3: hard truncation fallback —-- keep last tier messages, drop everything else ---
  const lastTier = KEEP_TIERS[KEEP_TIERS.length - 1];
  const hardSplitIdx = findSafeSplitIndex(truncated, lastTier);
  const hardKeep = truncated.slice(hardSplitIdx);
  const hardDropped = truncated.length - hardKeep.length;

  const hardResult: ChatMessage[] = [];
  if (system) hardResult.push(system);
  hardResult.push({
    role: 'user',
    content: `[System notice: ${hardDropped} earlier messages were removed to stay within context limits.]`,
  });
  hardResult.push({
    role: 'assistant',
    content: 'Understood. Earlier context was truncated. Please provide any important details if needed.',
  });
  hardResult.push(...hardKeep);

  const afterTokens = estimateTokens(hardResult, tools);
  logger.info(SCOPE, `Hard truncation fallback: ${beforeTokens} → ${afterTokens} tokens (dropped ${hardDropped}, kept ${hardKeep.length})`);

  return { messages: hardResult, removed: hardDropped, beforeTokens, afterTokens };
}
