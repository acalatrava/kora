import type { ToolDefinition } from '../core/types.js';

export const notifyToolDefinition: ToolDefinition = {
  name: 'notify',
  description: 'Send a message to the user. This is the ONLY way to communicate with the user. Use it to report progress, provide answers, ask questions, or share results. You MUST call this tool at least once before finishing. Set reply_expected=true when you need the user to answer a question before you can continue.',
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The message to deliver to the user. Supports markdown formatting.',
      },
      reply_expected: {
        type: 'boolean',
        description: 'If true, pause execution and wait for the user to reply (up to 5 minutes). Use when you need user input to continue. Defaults to false.',
      },
      attachments: {
        type: 'array',
        description: 'Optional file attachments to send alongside the message. Each item is a file to send.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the file to send.' },
            caption: { type: 'string', description: 'Optional caption for the file.' },
            type: { type: 'string', enum: ['photo', 'document'], description: 'Send as photo (image) or document. Defaults to document.' },
          },
          required: ['path'],
        },
      },
    },
    required: ['message'],
  },
};

export const finishToolDefinition: ToolDefinition = {
  name: 'finish',
  description: 'Signal that you have completed the current task. The summary parameter is an internal memory note and is NOT delivered to the user. You MUST use notify() to communicate with the user BEFORE calling finish(). This ends the current turn and stops iterating.',
  parameters: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'Internal memory note about what was accomplished. This is NOT sent to the user — it is only stored as a session memory. Keep it short and to the point.',
      },
    },
    required: ['summary'],
  },
};

export const waitForToolDefinition: ToolDefinition = {
  name: 'wait_for_tool',
  description: 'Wait for a detached tool execution to complete. When a tool takes longer than 30 seconds, it is automatically detached and continues running in the background. Use this tool to check on it or wait for its result.',
  parameters: {
    type: 'object',
    properties: {
      tool_execution_id: {
        type: 'string',
        description: 'The execution ID returned when the tool was detached.',
      },
      seconds: {
        type: 'number',
        description: 'How many seconds to wait for the tool to complete (default 30, max 300).',
      },
    },
    required: ['tool_execution_id'],
  },
};

export const killToolDefinition: ToolDefinition = {
  name: 'kill_tool',
  description: 'Kill a detached tool execution that is still running in the background. Use this when you no longer need the result or the tool appears stuck.',
  parameters: {
    type: 'object',
    properties: {
      tool_execution_id: {
        type: 'string',
        description: 'The execution ID of the detached tool to kill.',
      },
    },
    required: ['tool_execution_id'],
  },
};

export const taskReportToolDefinition: ToolDefinition = {
  name: 'task_report',
  description: 'Report the results of your task back to the main agent. This is the ONLY way to communicate results. Call this exactly once when your work is done.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['success', 'partial', 'failed'],
        description: 'Overall outcome of the task.',
      },
      summary: {
        type: 'string',
        description: 'Brief description of what was done.',
      },
      result: {
        type: 'string',
        description: 'Final useful output or answer to return to the main agent.',
      },
      findings: {
        type: 'array',
        items: { type: 'string' },
        description: 'Important findings or observations discovered during the task.',
      },
      actions_taken: {
        type: 'array',
        items: { type: 'string' },
        description: 'Steps that were executed.',
      },
      blockers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Issues that prevented completing the task (relevant when status is partial or failed).',
      },
    },
    required: ['status', 'summary'],
  },
};
