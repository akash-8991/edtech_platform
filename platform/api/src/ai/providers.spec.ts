import http from 'http';
import { AddressInfo } from 'net';
import { AnthropicProvider, OpenRouterProvider, ProviderError, RefusalError } from './providers';

type Handler = (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void;
async function stub(handler: Handler) {
  const seen: { url?: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => { const body = raw ? JSON.parse(raw) : {}; seen.push({ url: req.url, headers: req.headers, body }); handler(req, body, res); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => srv.close(r)) };
}
const req = { model: 'm', system: 'sys', user: 'usr', schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false }, schemaName: 'x', maxTokens: 100 };

describe('OpenRouterProvider', () => {
  beforeAll(() => { process.env.AI_RETRY_BASE_MS = '1'; });
  it('sends json_schema + data_collection:deny and parses usage/cost', async () => {
    const s = await stub((_r, _b, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'g1', model: 'vendor/m', choices: [{ finish_reason: 'stop', message: { content: '{"a":"ok"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0012 } })); });
    const r = await new OpenRouterProvider('k', s.url).complete(req);
    expect(r).toMatchObject({ json: { a: 'ok' }, inputTokens: 10, outputTokens: 5, costUsd: 0.0012 });
    const b = s.seen[0].body;
    expect(s.seen[0].headers.authorization).toBe('Bearer k');
    expect(b.provider).toEqual({ data_collection: 'deny', require_parameters: true });
    expect(b.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'x', strict: true } });
    expect(b.messages.map((m: any) => m.role)).toEqual(['system', 'user']);
    await s.close();
  });
  it('retries 429 then succeeds; gives up on 400 without retry', async () => {
    let n = 0;
    const s = await stub((_r, _b, res) => { n++; if (n === 1) { res.statusCode = 429; return res.end('slow down'); } res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"a":"1"}' } }], usage: {} })); });
    expect((await new OpenRouterProvider('k', s.url).complete(req)).json).toEqual({ a: '1' }); expect(n).toBe(2); await s.close();
    let m = 0; const s2 = await stub((_r, _b, res) => { m++; res.statusCode = 400; res.end('bad'); });
    await expect(new OpenRouterProvider('k', s2.url).complete(req)).rejects.toBeInstanceOf(ProviderError); expect(m).toBe(1); await s2.close();
  });
  it('maps content_filter to a refusal and truncation to a non-retryable error', async () => {
    const s = await stub((_r, _b, res) => res.end(JSON.stringify({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] })));
    await expect(new OpenRouterProvider('k', s.url).complete(req)).rejects.toBeInstanceOf(RefusalError); await s.close();
    const s2 = await stub((_r, _b, res) => res.end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"a"' } }] })));
    await expect(new OpenRouterProvider('k', s2.url).complete(req)).rejects.toMatchObject({ code: 'truncated' }); await s2.close();
  });
});

// Minimal Messages-API SSE stream, which is what the SDK's .stream() consumes.
const sse = (res: http.ServerResponse, text: string, stop: string, usage = { input_tokens: 20, output_tokens: 7 }) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (t: string, d: object) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
  ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } });
  if (text) { ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }); ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }); ev('content_block_stop', { index: 0 }); }
  ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  ev('message_stop', {}); res.end();
};

describe('AnthropicProvider', () => {
  it('uses the SDK stream with json_schema output_config + effort, no forced tool_choice/thinking-disable/sampling', async () => {
    const s = await stub((_r, _b, res) => sse(res, '{"a":"hi"}', 'end_turn'));
    const r = await new AnthropicProvider({ apiKey: 'k', baseURL: s.url }).complete({ ...req, model: 'claude-opus-5-5', effort: 'high' });
    expect(r).toMatchObject({ json: { a: 'hi' }, inputTokens: 20, outputTokens: 7, requestId: 'msg_1' });
    const b = s.seen[0].body;
    expect(s.seen[0].url).toContain('/v1/messages'); expect(b.stream).toBe(true);
    expect(b.model).toBe('claude-opus-5-5'); expect(b.output_config).toMatchObject({ effort: 'high', format: { type: 'json_schema' } });
    expect(b.thinking).toBeUndefined(); expect(b.tool_choice).toBeUndefined(); expect(b.temperature).toBeUndefined();
    expect(b.system).toBe('sys'); expect(b.messages).toEqual([{ role: 'user', content: 'usr' }]);
    await s.close();
  });
  it('treats stop_reason refusal as RefusalError and max_tokens as truncation', async () => {
    const s = await stub((_r, _b, res) => sse(res, '', 'refusal'));
    await expect(new AnthropicProvider({ apiKey: 'k', baseURL: s.url }).complete(req)).rejects.toBeInstanceOf(RefusalError); await s.close();
    const s2 = await stub((_r, _b, res) => sse(res, '{"a"', 'max_tokens'));
    await expect(new AnthropicProvider({ apiKey: 'k', baseURL: s2.url }).complete(req)).rejects.toMatchObject({ code: 'truncated' }); await s2.close();
  });
  it('maps API errors to non-retryable ProviderError with status (SDK already retried)', async () => {
    const s = await stub((_r, _b, res) => { res.statusCode = 401; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } })); });
    await expect(new AnthropicProvider({ apiKey: 'k', baseURL: s.url }).complete(req)).rejects.toMatchObject({ code: 'http_401', status: 401 }); await s.close();
  });
});
