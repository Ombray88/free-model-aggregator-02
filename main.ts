// free-model-aggregator-02: live gateway aggregator (Node 22, rating-order routing, per-model failover)
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  catalogSummary,
  freeModels,
  isRecord,
  readBrief,
  type CatalogReport,
  type Json,
  type Requirement,
} from './lib/providers.ts';
import { Router, routeReport } from './lib/router.ts';
import {
  buildUpstreamBody,
  buildOpenAIJsonResponse,
  buildAnthropicJsonResponse,
  buildOpenAISseResponse,
  buildAnthropicSseResponse,
} from './lib/translate.ts';
import { callOpenAI, isRetryable, recentFailures, noteFailure, type UpstreamResult } from './lib/upstream.ts';
import {
  anthropicError,
  anthropicModelList,
  openAIError,
  openAIModelList,
  type ServedModel,
} from './lib/wire.ts';
import {
  validateChatRequest,
  validateAnthropicRequest,
  badRequestBody,
} from './lib/validate.ts';

const VERSION = "1.1.0";
const metrics = {
  startedAt: Date.now(),
  requests: 0,
  byModel: new Map<string, number>(),
  byStatus: new Map<string, number>(),
};

function recordMetric(modelId: string, status: number): void {
  metrics.requests += 1;
  metrics.byModel.set(modelId, (metrics.byModel.get(modelId) ?? 0) + 1);
  const s = String(status);
  metrics.byStatus.set(s, (metrics.byStatus.get(s) ?? 0) + 1);
}

const PROTOCOL_VERSION = 1;
const POLL_INTERVAL_MS = 100;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
const router = new Router(brief);
let manifestIndex = 0;

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({
    id: model.id,
    provider: model.provider,
    display_name: model.display_name,
  }));
}

function requirementsFromBody(body: Json): Requirement {
  let vision = false;
  let json = false;
  let tools = false;

  if (isRecord(body)) {
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (isRecord(msg) && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (isRecord(block)) {
              if (block.type === 'image' || block.type === 'image_url') {
                vision = true;
              }
            }
          }
        }
      }
    }

    if (isRecord(body.response_format)) {
      const rfType = body.response_format.type;
      if (rfType === 'json_object' || rfType === 'json_schema') {
        json = true;
      }
    }

    if (Array.isArray(body.tools) && body.tools.length > 0) {
      tools = true;
    }
  }

  return { tools, vision, json };
}

async function readJson(req: IncomingMessage): Promise<Json | null> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    const buf = Buffer.concat(chunks);
    const parsed: unknown = JSON.parse(buf.toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | number> = {}): void {
  const payload = JSON.stringify(body);
  const buf = Buffer.from(payload, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': buf.length,
    ...headers,
  });
  res.end(buf);
}

async function handleChatOrMessages(
  req: IncomingMessage,
  res: ServerResponse,
  clientWire: 'openai' | 'anthropic'
): Promise<void> {
  const body = await readJson(req);
  if (!body) {
    const errBody =
      clientWire === 'anthropic'
        ? anthropicError('invalid_request_error', 'the request body is not one JSON object')
        : openAIError('the request body is not one JSON object', 'invalid_request_error', 'invalid_request');
    recordMetric('', 400);
    sendJson(res, 400, errBody);
    return;
  }

  const validation = clientWire === 'anthropic' ? validateAnthropicRequest(body) : validateChatRequest(body);
  if (!validation.ok) {
    recordMetric('', 400);
    sendJson(res, 400, badRequestBody(validation.error));
    return;
  }

  const promptEntry = brief.prompts[manifestIndex];
  const requestId = promptEntry ? promptEntry.id : `req_${manifestIndex}`;
  const requires = promptEntry ? promptEntry.requires : requirementsFromBody(body);
  manifestIndex += 1;

  const stream = body.stream === true;
  const failures: { status: number; code: string; model: string }[] = [];
  let triedAny = false;
  let lastError: UpstreamResult | null = null;
  let lastModelId = '';

  while (true) {
    const candidate = router.nextCandidate(requestId, requires);
    if (!candidate) break;
    triedAny = true;
    lastModelId = candidate.modelId;

    const upstreamBody = buildUpstreamBody(clientWire, body, candidate.modelId, stream);
    const result = await callOpenAI(GATEWAY_URL, GATEWAY_KEY, candidate.modelId, upstreamBody, stream);

    if (result.ok) {
      router.noteSuccess(candidate.modelId);
      const headers: Record<string, string | number> = {};
      if (failures.length > 0) {
        headers['x-makefun-upstream-failures'] = JSON.stringify(failures.slice(0, 8));
      }

      if (stream) {
        headers['content-type'] = 'text/event-stream';
        headers['cache-control'] = 'no-cache';
        headers['connection'] = 'keep-alive';
        res.writeHead(200, headers);
        const sseText =
          clientWire === 'openai'
            ? buildOpenAISseResponse(result, candidate.modelId)
            : buildAnthropicSseResponse(result, candidate.modelId);
        res.end(sseText);
      } else {
        headers['content-type'] = 'application/json';
        const jsonRes =
          clientWire === 'openai'
            ? buildOpenAIJsonResponse(result, candidate.modelId)
            : buildAnthropicJsonResponse(result, candidate.modelId);
        const payload = JSON.stringify(jsonRes);
        headers['content-length'] = Buffer.byteLength(payload, 'utf8');
        res.writeHead(200, headers);
        res.end(payload);
      }
      recordMetric(candidate.modelId, 200);
      return;
    } else {
      lastError = result;
      failures.push({
        status: result.status,
        code: result.code || String(result.status),
        model: candidate.modelId,
      });
      noteFailure(result.status, result.code || String(result.status), candidate.modelId);
      if (isRetryable(result.status)) {
        log(`model ${candidate.modelId} failed with retryable status ${result.status} (${result.code || 'error'}): ${result.message}; failing over to next candidate`);
        router.noteFailure(candidate.modelId, result.message);
      } else {
        break;
      }
    }
  }

  if (!triedAny) {
    const errBody =
      clientWire === 'anthropic'
        ? anthropicError('server_error', 'no free model on the directory meets this request')
        : openAIError('no free model on the directory meets this request', 'server_error', 'service_unavailable');
    recordMetric('', 503);
    sendJson(res, 503, errBody);
    return;
  }

  const errStatus = lastError && lastError.status > 0 ? lastError.status : 502;
  const errMsg = lastError ? lastError.message : 'upstream failure';
  const errCode = lastError ? lastError.code : 'bad_gateway';

  const errBody =
    clientWire === 'anthropic'
      ? anthropicError(errCode || 'api_error', errMsg)
      : openAIError(errMsg, errCode || 'api_error', errCode);
  const errHeaders: Record<string, string | number> = {};
  if (failures.length > 0) {
    errHeaders['x-makefun-upstream-failures'] = JSON.stringify(failures.slice(0, 8));
  }
  recordMetric(lastModelId, errStatus);
  sendJson(res, errStatus, errBody, errHeaders);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '', 'http://entry');
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, {
      status: "ok",
      version: VERSION,
      models: servedModels().length,
      uptimeMs: Date.now() - metrics.startedAt,
      requests: metrics.requests,
    });
    return;
  }
  if (method === 'GET' && pathname === '/metrics') {
    sendJson(res, 200, {
      requests: metrics.requests,
      byModel: Object.fromEntries(metrics.byModel),
      byStatus: Object.fromEntries(metrics.byStatus),
      uptimeMs: Date.now() - metrics.startedAt,
    });
    return;
  }
  if (method === 'GET' && pathname === '/catalog') {
    sendJson(res, 200, catalogSummary(catalog));
    return;
  }
  if (method === 'GET' && pathname === '/routes') {
    sendJson(res, 200, routeReport(router, brief));
    return;
  }
  if (method === 'GET' && pathname === '/failures') {
    sendJson(res, 200, { failures: recentFailures });
    return;
  }

  if (method === 'GET' && pathname === '/v1/models') {
    const hasApiKey = Boolean(req.headers['x-api-key']);
    const list = servedModels();
    const body = hasApiKey ? anthropicModelList(list) : openAIModelList(list);
    sendJson(res, 200, body);
    return;
  }
  if (method === 'POST' && pathname === '/v1/chat/completions') {
    await handleChatOrMessages(req, res, 'openai');
    return;
  }
  if (method === 'POST' && pathname === '/v1/messages') {
    await handleChatOrMessages(req, res, 'anthropic');
    return;
  }

  const isAnthropic = pathname === '/v1/messages' || Boolean(req.headers['x-api-key']);
  const errBody =
    isAnthropic
      ? anthropicError('invalid_request_error', `no route ${method} ${pathname}`)
      : openAIError(`no route ${method} ${pathname}`, 'invalid_request_error', 'invalid_request');
  sendJson(res, 404, errBody);
}

async function register(port: number, report: CatalogReport): Promise<void> {
  const url = ENV_URL + '/register';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`POST ${url} answered HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (isRecord(json) && typeof json.requests === 'number') {
      log(`registered: the workload holds ${json.requests} requests`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(ENV_URL + '/work', { signal: controller.signal });
      if (res.status === 200) {
        const text = await res.text();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
        if (isRecord(data) && data.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      }
    } catch {
      // Swallow errors
    } finally {
      clearTimeout(timeout);
      inFlight = false;
    }
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (process.argv.includes('--version')) {
    process.stdout.write(VERSION + '\n');
    process.exit(0);
  }
  if (process.argv.includes('--list')) {
    process.stdout.write(JSON.stringify(catalog) + '\n');
    process.exit(0);
  }
  if (!ENV_URL) {
    throw new Error('MAKEFUN_ENV_URL is not set');
  }

  console.error(`aggregator: catalog ${JSON.stringify(catalogSummary(catalog))}`);

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      log(err instanceof Error ? err.stack || err.message : String(err));
      if (!res.headersSent) {
        const isAnthropic = (req.url || '').startsWith('/v1/messages') || Boolean(req.headers['x-api-key']);
        const errBody =
          isAnthropic
            ? anthropicError('server_error', 'the server failed to answer')
            : openAIError('the server failed to answer', 'server_error', 'internal_server_error');
        sendJson(res, 500, errBody);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('invalid server address');
  }
  const port = addr.port;
  if (port === 8080) {
    throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  }

  log(`listening on 0.0.0.0:${port} with ${catalog.providers.length} providers and ${servedModels().length} free models`);
  await register(port, catalog);

  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));

  poll(server);
}

try {
  await start();
} catch (err) {
  log(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
}
