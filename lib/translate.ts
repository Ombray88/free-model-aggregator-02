/**
 * Wire translation module adapted from v2 reference and wire.ts.
 */

import { isRecord, type Json } from './providers.ts';
import type { UpstreamResult } from './upstream.ts';

export type ClientWire = 'openai' | 'anthropic';

/**
 * Maps a provider finish_reason / stop reason to an OpenAI finish_reason.
 */
export function mapStopToOpenAI(stop: unknown, hasTools: boolean): string {
  if (hasTools || stop === 'tool_calls' || stop === 'function_call') return 'tool_calls';
  const s = typeof stop === 'string' ? stop.toLowerCase() : 'stop';
  if (s === 'stop' || s === 'end_turn') return 'stop';
  if (s === 'max_tokens' || s === 'length') return 'length';
  if (s === 'content_filter') return 'content_filter';
  return 'stop';
}

/**
 * Maps a provider finish_reason / stop reason to an Anthropic stop_reason.
 */
export function mapStopToAnthropic(stop: unknown, hasTools: boolean): string {
  if (hasTools || stop === 'tool_calls' || stop === 'function_call' || stop === 'tool_use') return 'tool_use';
  const s = typeof stop === 'string' ? stop.toLowerCase() : 'end_turn';
  if (s === 'max_tokens' || s === 'length') return 'max_tokens';
  if (s === 'stop' || s === 'end_turn') return 'end_turn';
  if (s === 'content_filter') return 'stop';
  return 'end_turn';
}

/**
 * Extracts text from a string or Anthropic content blocks array.
 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n');
}

/**
 * Converts an Anthropic content block into an OpenAI content part.
 */
function partOf(block: Json): Json | null {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }
  if (block.type === 'image' && isRecord(block.source)) {
    const source = block.source;
    if (source.type === 'base64' && typeof source.data === 'string') {
      const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
      return { type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } };
    }
    if (source.type === 'url' && typeof source.url === 'string') {
      return { type: 'image_url', image_url: { url: source.url } };
    }
  }
  return null;
}

/**
 * Converts a tool_result block content into text.
 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = textOf(content);
    return text !== '' ? text : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/**
 * Parses arguments into an object.
 */
function argumentsOf(value: unknown): Json {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON
    }
  }
  return {};
}

/**
 * Translates a client request body (OpenAI or Anthropic) into the Chat Completions body required by the gateway.
 */
export function buildUpstreamBody(
  clientWire: ClientWire,
  body: Json,
  modelId: string,
  stream: boolean
): Json {
  const payload = JSON.parse(JSON.stringify(body));
  payload.model = modelId;
  payload.stream = stream;

  if (stream) {
    payload.stream_options = {
      ...(isRecord(payload.stream_options) ? payload.stream_options : {}),
      include_usage: true,
    };
  }

  if (clientWire === 'openai') {
    return payload;
  }

  // Anthropic to OpenAI translation
  const messages: Json[] = [];
  const system = textOf(payload.system);
  if (system !== '') {
    messages.push({ role: 'system', content: system });
  }

  const sourceMessages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const raw of sourceMessages) {
    if (!isRecord(raw)) continue;
    const assistant = raw.role === 'assistant';
    const content = raw.content;

    if (typeof content === 'string') {
      messages.push({ role: assistant ? 'assistant' : 'user', content });
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    if (assistant) {
      const toolCalls: Json[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue;
        toolCalls.push({
          id: typeof block.id === 'string' ? block.id : '',
          type: 'function',
          function: {
            name: typeof block.name === 'string' ? block.name : '',
            arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
          },
        });
      }
      const text = textOf(content);
      messages.push({
        role: 'assistant',
        content: text !== '' ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    const parts: Json[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          content: toolResultText(block.content),
        });
        continue;
      }
      const part = partOf(block);
      if (part !== null) {
        parts.push(part);
      }
    }
    if (parts.length > 0) {
      messages.push({ role: 'user', content: parts });
    }
  }

  const openaiBody: Json = {
    model: modelId,
    messages,
    stream,
  };
  if (stream) {
    openaiBody.stream_options = { include_usage: true };
  }
  if (typeof payload.max_tokens === 'number') {
    openaiBody.max_tokens = payload.max_tokens;
  }
  if (typeof payload.temperature === 'number') {
    openaiBody.temperature = payload.temperature;
  }
  if (typeof payload.top_p === 'number') {
    openaiBody.top_p = payload.top_p;
  }
  if (Array.isArray(payload.stop_sequences) && payload.stop_sequences.length > 0) {
    openaiBody.stop = payload.stop_sequences;
  } else if (payload.stop) {
    openaiBody.stop = payload.stop;
  }

  if (Array.isArray(payload.tools)) {
    const tools = payload.tools.flatMap((raw: unknown) => {
      if (!isRecord(raw) || typeof raw.name !== 'string') return [];
      return [
        {
          type: 'function',
          function: {
            name: raw.name,
            description: typeof raw.description === 'string' ? raw.description : '',
            parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
          },
        },
      ];
    });
    if (tools.length > 0) {
      openaiBody.tools = tools;
    }
  }

  const choice = payload.tool_choice;
  if (isRecord(choice)) {
    if (choice.type === 'auto') openaiBody.tool_choice = 'auto';
    else if (choice.type === 'any') openaiBody.tool_choice = 'required';
    else if (choice.type === 'tool' && typeof choice.name === 'string') {
      openaiBody.tool_choice = { type: 'function', function: { name: choice.name } };
    }
  }

  return openaiBody;
}

/**
 * Builds an OpenAI-shaped JSON response, ensuring the dialled modelId (with openrouter/ prefix) is set.
 */
export function buildOpenAIJsonResponse(result: UpstreamResult | Json, modelId: string): Json {
  const raw = isRecord(result) ? result : {};
  const body = isRecord(raw.body) ? (raw.body as Json) : raw;
  
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const finishReason = mapStopToOpenAI(choice.finish_reason, toolCalls.length > 0);

  const usage = isRecord(body.usage) ? body.usage : {};
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;

  return {
    ...body,
    model: modelId,
    choices: [
      {
        ...choice,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/**
 * Builds an Anthropic-shaped JSON response from a Chat Completions result, ensuring the modelId is set.
 */
export function buildAnthropicJsonResponse(result: UpstreamResult | Json, modelId: string): Json {
  const raw = isRecord(result) ? result : {};
  const body = isRecord(raw.body) ? (raw.body as Json) : raw;

  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  
  const content: Json[] = [];
  const text = typeof message.content === 'string' ? message.content : textOf(message.content);
  if (text !== '') {
    content.push({ type: 'text', text });
  }

  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    if (!isRecord(call)) continue;
    const fn = isRecord(call.function) ? call.function : {};
    content.push({
      type: 'tool_use',
      id: typeof call.id === 'string' ? call.id : 'toolu_unknown',
      name: typeof fn.name === 'string' ? fn.name : '',
      input: argumentsOf(fn.arguments),
    });
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  const usage = isRecord(body.usage) ? body.usage : {};
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const stopReason = mapStopToAnthropic(choice.finish_reason, calls.length > 0);

  return {
    id: `msg_${typeof body.id === 'string' ? body.id : 'aggregate'}`,
    type: 'message',
    role: 'assistant',
    model: modelId,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}

/**
 * Builds OpenAI-style Server-Sent Event frames from stream text or result.
 */
export function buildOpenAISseResponse(result: UpstreamResult | string, modelId: string): string {
  const rawText = typeof result === 'string' ? result : (result.text || JSON.stringify(result));
  const lines = rawText.split(/\r?\n/);
  const outLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      outLines.push(line);
      continue;
    }
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]' || payload === '') {
      outLines.push(line);
      continue;
    }
    try {
      const chunk: unknown = JSON.parse(payload);
      if (isRecord(chunk)) {
        outLines.push(`data: ${JSON.stringify({ ...chunk, model: modelId })}`);
      } else {
        outLines.push(line);
      }
    } catch {
      outLines.push(line);
    }
  }
  return outLines.join('\n') + (outLines.length > 0 && !outLines[outLines.length - 1].endsWith('\n') ? '\n' : '');
}

/**
 * Builds Anthropic-style Server-Sent Event frames from an OpenAI stream text or result.
 */
export function buildAnthropicSseResponse(result: UpstreamResult | string, modelId: string): string {
  const rawText = typeof result === 'string' ? result : (result.text || JSON.stringify(result));
  const lines: string[] = [];

  const send = (event: string, data: any) => {
    lines.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let started = false;
  let finished = false;
  let pendingStop = 'end_turn';
  let textIndex = -1;
  let nextIndex = 0;
  const toolIndexes = new Map<number, number>();
  let inputTokens = 0;
  let outputTokens = 0;

  const startEvents = () => {
    if (started) return [];
    started = true;
    return [
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_stream',
          type: 'message',
          role: 'assistant',
          model: modelId,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      }),
    ];
  };

  const closeEvents = () => {
    const out: string[] = [];
    if (textIndex !== -1) {
      out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: textIndex }));
      textIndex = -1;
    }
    for (const index of [...toolIndexes.values()].sort((a, b) => a - b)) {
      out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index }));
    }
    toolIndexes.clear();
    return out;
  };

  const finishEvents = (stopReason: string) => {
    if (finished) return [];
    finished = true;
    return [
      ...closeEvents(),
      sseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }),
      sseEvent('message_stop', { type: 'message_stop' }),
    ];
  };

  const frames = rawText.split(/\r?\n\r?\n/);
  for (const frame of frames) {
    for (const line of frame.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]' || payload === '') continue;

      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (!isRecord(chunk)) continue;

      if (isRecord(chunk.usage)) {
        inputTokens = Number(chunk.usage.prompt_tokens ?? chunk.usage.input_tokens ?? inputTokens) || inputTokens;
        outputTokens = Number(chunk.usage.completion_tokens ?? chunk.usage.output_tokens ?? outputTokens) || outputTokens;
      }

      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = isRecord(choices[0]) ? choices[0] : null;
      if (choice === null) continue;

      const delta = isRecord(choice.delta) ? choice.delta : {};
      for (const ev of startEvents()) lines.push(ev);

      if (typeof delta.content === 'string' && delta.content !== '') {
        if (textIndex === -1) {
          textIndex = nextIndex;
          nextIndex += 1;
          send('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } });
        }
        send('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } });
      }

      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const call of calls) {
        if (!isRecord(call)) continue;
        const upstreamIndex = typeof call.index === 'number' ? call.index : toolIndexes.size;
        let index = toolIndexes.get(upstreamIndex);
        if (index === undefined) {
          if (textIndex !== -1) {
            send('content_block_stop', { type: 'content_block_stop', index: textIndex });
            textIndex = -1;
          }
          index = nextIndex;
          nextIndex += 1;
          toolIndexes.set(upstreamIndex, index);
          const fn = isRecord(call.function) ? call.function : {};
          send('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              id: typeof call.id === 'string' && call.id !== '' ? call.id : `toolu_${index}`,
              name: typeof fn.name === 'string' ? fn.name : '',
              input: {},
            },
          });
        }
        const fn = isRecord(call.function) ? call.function : {};
        if (typeof fn.arguments === 'string' && fn.arguments !== '') {
          send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: fn.arguments } });
        }
      }

      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        pendingStop = mapStopToAnthropic(choice.finish_reason, calls.length > 0);
      }
    }
  }

  if (!started) {
    for (const ev of startEvents()) lines.push(ev);
  }
  if (!finished) {
    for (const ev of finishEvents(pendingStop)) lines.push(ev);
  }

  return lines.join('');
}

function sseEvent(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}
