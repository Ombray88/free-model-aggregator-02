/**
 * Upstream provider communication module for the OpenAI-compatible gateway.
 */

export interface UpstreamResult {
  ok: boolean;
  status: number;
  code: string;
  message: string;
  body?: unknown;
  text?: string;
}

/**
 * Returns whether an HTTP status code is retryable.
 * True for 0 (network), 403 (model-restricted/agentic harness restriction), 429, 408, 500, 502, 503, 504; false otherwise.
 * 400 and 401 are not retryable (client errors / bad auth).
 */
export function isRetryable(status: number): boolean {
  if (status === 0 || status === 403 || status === 429 || status === 408 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return false;
}

/**
 * Performs an HTTP POST request to the OpenAI-compatible chat completions endpoint.
 */
export async function callOpenAI(
  baseUrl: string,
  key: string,
  modelId: string,
  body: Record<string, any>,
  stream: boolean
): Promise<UpstreamResult> {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const payload: Record<string, any> = {
    ...body,
    model: modelId,
    stream,
  };
  if (stream) {
    payload.stream_options = {
      ...(payload.stream_options || {}),
      include_usage: true,
    };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        ...(stream ? { 'Accept': 'text/event-stream' } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      code: 'network',
      message: err?.message || 'Network error',
    };
  }

  if (response.ok) {
    if (stream) {
      const text = await response.text();
      return {
        ok: true,
        status: response.status,
        code: '',
        message: '',
        text,
      };
    } else {
      let jsonBody: unknown;
      try {
        jsonBody = await response.json();
      } catch (err: any) {
        return {
          ok: false,
          status: response.status,
          code: 'json_parse_error',
          message: err?.message || 'Failed to parse JSON response',
        };
      }
      return {
        ok: true,
        status: response.status,
        code: '',
        message: '',
        body: jsonBody,
      };
    }
  } else {
    const status = response.status;
    let code = String(status);
    let message = response.statusText || 'Error';
    try {
      const errText = await response.text();
      if (errText.trim()) {
        try {
          const errJson = JSON.parse(errText);
          if (errJson && typeof errJson === 'object') {
            const errObj = (errJson as any).error || errJson;
            if (typeof errObj.code === 'string' && errObj.code) {
              code = errObj.code;
            }
            if (typeof errObj.message === 'string' && errObj.message) {
              message = errObj.message;
            }
          }
        } catch {
          message = errText.slice(0, 500);
        }
      }
    } catch {
      // Ignore text read error
    }
    return {
      ok: false,
      status,
      code,
      message,
    };
  }
}
