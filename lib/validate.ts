/**
 * Request validation module for inbound chat-completions and Anthropic-messages bodies before any gateway call.
 */

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function validateChatRequest(body: unknown): ValidationResult {
  if (!isRecord(body)) {
    return { ok: false, error: 'body must be a record' };
  }

  if (typeof body.model !== 'string' || body.model.trim() === '') {
    return { ok: false, error: 'model must be a non-empty string' };
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, error: 'messages must be a non-empty array' };
  }

  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (!isRecord(msg)) {
      return { ok: false, error: `messages[${i}] must be a record` };
    }
    if (typeof msg.role !== 'string') {
      return { ok: false, error: `messages[${i}].role must be a string` };
    }
    if (!('content' in msg) || msg.content === undefined) {
      return { ok: false, error: `messages[${i}].content must be present` };
    }
    if (typeof msg.content !== 'string' && !Array.isArray(msg.content)) {
      return { ok: false, error: `messages[${i}].content must be a string or an array` };
    }
  }

  if ('stream' in body && body.stream !== undefined && typeof body.stream !== 'boolean') {
    return { ok: false, error: 'stream must be a boolean' };
  }

  if ('temperature' in body && body.temperature !== undefined && (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature))) {
    return { ok: false, error: 'temperature must be a finite number' };
  }

  if ('max_tokens' in body && body.max_tokens !== undefined && (typeof body.max_tokens !== 'number' || !Number.isInteger(body.max_tokens) || body.max_tokens <= 0)) {
    return { ok: false, error: 'max_tokens must be a positive integer' };
  }

  return { ok: true };
}

export function validateAnthropicRequest(body: unknown): ValidationResult {
  if (!isRecord(body)) {
    return { ok: false, error: 'body must be a record' };
  }

  if (typeof body.model !== 'string' || body.model.trim() === '') {
    return { ok: false, error: 'model must be a non-empty string' };
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, error: 'messages must be a non-empty array' };
  }

  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (!isRecord(msg)) {
      return { ok: false, error: `messages[${i}] must be a record` };
    }
    if (typeof msg.role !== 'string') {
      return { ok: false, error: `messages[${i}].role must be a string` };
    }
    if (!('content' in msg) || msg.content === undefined) {
      return { ok: false, error: `messages[${i}].content must be present` };
    }
    if (typeof msg.content !== 'string' && !Array.isArray(msg.content)) {
      return { ok: false, error: `messages[${i}].content must be a string or an array` };
    }
  }

  if (typeof body.max_tokens !== 'number' || !Number.isInteger(body.max_tokens) || body.max_tokens <= 0) {
    return { ok: false, error: 'max_tokens must be a positive integer' };
  }

  if ('stream' in body && body.stream !== undefined && typeof body.stream !== 'boolean') {
    return { ok: false, error: 'stream must be a boolean' };
  }

  return { ok: true };
}

export function badRequestBody(error: string): { error: { message: string; type: string; code: string } } {
  return {
    error: {
      message: error,
      type: 'invalid_request_error',
      code: 'bad_request',
    },
  };
}
