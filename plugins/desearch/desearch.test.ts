import { randomUUID } from 'node:crypto';
import { handler } from './online';
import manifest from './manifest.json';

const key = randomUUID();
const parameters = { credentials: { apiKey: key } };
const context = {
  requestType: 'chatComplete' as const,
  request: {
    json: {
      model: 'example-model',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Portkey documentation' },
      ],
    },
  },
};
const rows = [
  {
    title: 'Portkey',
    link: 'https://docs.portkey.ai/',
    snippet: 'Gateway docs',
  },
  {
    title: 'Desearch',
    link: 'https://www.desearch.ai/',
    snippet: 'Search docs',
  },
];
const rpc = (id: number, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { 'Content-Type': 'application/json' },
  });
const init = () =>
  rpc(1, { protocolVersion: '2025-03-26', capabilities: { tools: {} } });
const tool = (data: unknown = { data: rows }) =>
  rpc(2, { content: [{ type: 'text', text: JSON.stringify(data) }] });
let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn();
  jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});
function setup(response = tool()) {
  fetchMock
    .mockResolvedValueOnce(init())
    .mockResolvedValueOnce(new Response(null, { status: 202 }))
    .mockResolvedValueOnce(response);
}
const run = (params = parameters, ctx = context) =>
  handler(ctx, params, 'beforeRequestHook');

it('declares the transformer and encrypted user key', () => {
  expect(manifest.id).toBe('desearch');
  expect(manifest.credentials.properties.apiKey.encrypted).toBe(true);
  expect(manifest.functions[0].supportedHooks).toEqual(['beforeRequestHook']);
});

it('uses the hosted MCP tool and preserves the original chat request', async () => {
  setup();
  const original = JSON.stringify(context);
  const result = await run();
  expect(result.error).toBeNull();
  expect(result.transformed).toBe(true);
  expect(result.data.sources).toEqual([
    { title: 'Portkey', url: rows[0].link, snippet: rows[0].snippet },
    { title: 'Desearch', url: rows[1].link, snippet: rows[1].snippet },
  ]);
  expect(JSON.stringify(context)).toBe(original);
  const updated = result.transformedData.request.json;
  expect(updated.messages[0].content).toContain('Be concise.');
  expect(updated.messages[0].content).toContain('untrusted reference data');
  expect(updated.messages[1]).toEqual(context.request.json.messages[1]);
  expect(updated.model).toBe('example-model');
  expect(fetchMock.mock.calls).toHaveLength(3);
  const [url, request] = fetchMock.mock.calls[2];
  expect(url).toBe('https://mcp.desearch.ai/mcp');
  expect(request.redirect).toBe('error');
  expect(request.headers['x-api-key']).toBe(key);
  expect(JSON.parse(request.body)).toEqual({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'web-search',
      arguments: { query: 'Portkey documentation' },
    },
  });
  expect(JSON.stringify(result)).not.toContain(key);
});

it('uses the environment key and respects the local result limit', async () => {
  setup();
  const result = await handler(
    context,
    { numResults: 1 },
    'beforeRequestHook',
    { env: { DESEARCH_API_KEY: key } }
  );
  expect(result.data.sources).toHaveLength(1);
  expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBe(key);
});

it('prepends reference context to a string completion prompt', async () => {
  setup();
  const result = await handler(
    { requestType: 'complete', request: { json: { prompt: 'Portkey' } } },
    parameters,
    'beforeRequestHook'
  );
  expect(result.transformedData.request.json.prompt).toMatch(/Portkey$/);
  expect(result.transformedData.request.json.prompt).toContain(rows[0].link);
});

it('searches text parts of the last user message without changing images', async () => {
  setup();
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'Instructions' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Portkey' },
        { type: 'image_url', image_url: { url: 'https://example.com/image' } },
        { type: 'text', text: 'gateway' },
      ],
    },
    { role: 'assistant', content: 'Working on it' },
  ];
  const result = await handler(
    { requestType: 'chatComplete', request: { json: { messages } } },
    parameters,
    'beforeRequestHook'
  );
  expect(result.transformedData.request.json.messages.slice(1)).toEqual(
    messages
  );
  expect(
    JSON.parse(fetchMock.mock.calls[2][1].body).params.arguments.query
  ).toBe('Portkey gateway');
});

it('reads a matching chunked SSE response and cancels an open stream', async () => {
  let cancelled = false;
  const text =
    ': ping\r\n\r\ndata: {"jsonrpc":"2.0","method":"notice"}\r\n\r\n' +
    `data: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ data: rows }) }],
      },
    })}\r\n\r\n`;
  const stream = new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(text);
      controller.enqueue(bytes.slice(0, 9));
      controller.enqueue(bytes.slice(9));
      // Deliberately keep the connection open after the matching RPC result.
    },
    cancel() {
      cancelled = true;
    },
  });
  setup(
    new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
  );
  expect((await run()).transformed).toBe(true);
  expect(cancelled).toBe(true);
});

it('forwards an MCP session identifier without exposing it', async () => {
  const session = randomUUID();
  const initialized = init();
  initialized.headers.set('Mcp-Session-Id', session);
  fetchMock
    .mockResolvedValueOnce(initialized)
    .mockResolvedValueOnce(new Response(null, { status: 202 }))
    .mockResolvedValueOnce(tool());
  const result = await run();
  expect(fetchMock.mock.calls[2][1].headers['Mcp-Session-Id']).toBe(session);
  expect(JSON.stringify(result)).not.toContain(session);
});

it('keeps empty searches unchanged', async () => {
  setup(tool({ data: [] }));
  expect(await run()).toEqual({
    error: null,
    verdict: true,
    transformed: false,
    data: { sources: [] },
  });
});

it('drops unsafe URLs and redacts a reflected credential', async () => {
  setup(
    tool({
      data: [
        { title: key, link: 'javascript:alert(1)', snippet: key },
        { title: key, link: 'https://user:pass@example.com/', snippet: key },
        { title: key, link: `https://example.com/?key=${key}`, snippet: key },
        { title: key, link: 'https://example.com/', snippet: key },
      ],
    })
  );
  const result = await run();
  expect(result.data.sources).toHaveLength(1);
  expect(result.data.sources[0].title).toBe('[redacted]');
  expect(JSON.stringify(result)).not.toContain(key);
});

it.each([
  ['afterRequestHook', 'chatComplete'],
  ['beforeRequestHook', 'embed'],
  ['beforeRequestHook', 'messages'],
])('skips %s for %s', async (event, type) => {
  const result = await handler(
    { requestType: type as any },
    parameters,
    event as any
  );
  expect(result.error).toBeNull();
  expect(result.transformed).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('rejects a missing key before contacting the server', async () => {
  expect((await handler(context, {}, 'beforeRequestHook')).error.message).toBe(
    'Desearch API key is required.'
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([['batch'], '', 'x'.repeat(8001)])(
  'rejects unsupported or oversized completion input',
  async (prompt) => {
    const result = await handler(
      { requestType: 'complete', request: { json: { prompt } } },
      parameters,
      'beforeRequestHook'
    );
    expect(result.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  }
);

it('rejects an unsupported protocol before searching', async () => {
  fetchMock.mockResolvedValueOnce(
    rpc(1, { protocolVersion: 'unknown', capabilities: { tools: {} } })
  );
  expect((await run()).error).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('rejects an unsuccessful initialization notification', async () => {
  fetchMock
    .mockResolvedValueOnce(init())
    .mockResolvedValueOnce(new Response(key, { status: 500 }));
  const result = await run();
  expect(result.error).toBeTruthy();
  expect(JSON.stringify(result)).not.toContain(key);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each([
  { numResults: 0 },
  { numResults: 11 },
  { numResults: 1.5 },
  { timeout: 0 },
  { timeout: 60001 },
  { timeout: '1000' },
])('rejects invalid parameters %j', async (extra) => {
  expect((await run({ ...parameters, ...extra })).error).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([{}, { messages: [] }, { messages: [{ role: 'user', content: '' }] }])(
  'rejects malformed chat input',
  async (json) => {
    const result = await handler(
      { requestType: 'chatComplete', request: { json } },
      parameters,
      'beforeRequestHook'
    );
    expect(result.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  }
);

it.each([
  () => new Response('broken JSON'),
  () => new Response(key, { status: 401 }),
  () => new Response(key, { status: 429 }),
  () => rpc(2, { isError: true, content: [{ type: 'text', text: key }] }),
  () => tool({ unexpected: key }),
  () => new Response('x'.repeat(1_000_001)),
  () => rpc(99, {}),
  () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, error: key })),
])(
  'suppresses malformed responses and reflected error secrets',
  async (response) => {
    const log = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    setup(response());
    const result = await run();
    expect(result.error.message).toBe('Desearch web search failed.');
    expect(result.transformed).toBe(false);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(log).not.toHaveBeenCalled();
  }
);

it('bounds the entire MCP exchange by the configured timeout', async () => {
  jest.useFakeTimers();
  fetchMock.mockImplementation(
    (_url, request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error(key)));
      })
  );
  const pending = run({ ...parameters, timeout: 20 } as any);
  await jest.advanceTimersByTimeAsync(20);
  const result = await pending;
  expect(result.error.message).toBe('Desearch web search failed.');
  expect(JSON.stringify(result)).not.toContain(key);
});
