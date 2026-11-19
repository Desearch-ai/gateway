import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HooksManager } from '../../src/middlewares/hooks';
import { HookType } from '../../src/middlewares/hooks/types';
import { handler } from './online';

// Run only after enabling desearch in conf.json and building the plugin registry.
async function main() {
  const apiKey = process.env.DESEARCH_API_KEY;
  assert(apiKey, 'Set DESEARCH_API_KEY in the environment.');
  const manager = new HooksManager();
  const span = manager.createSpan(
    {
      messages: [{ role: 'user', content: 'Portkey AI gateway documentation' }],
    },
    {},
    'openai',
    false,
    [
      {
        id: 'web-context',
        type: HookType.MUTATOR,
        eventType: 'beforeRequestHook',
        checks: [{ id: 'desearch.online', parameters: { numResults: 3 } }],
      },
    ],
    [],
    null,
    'chatComplete',
    {}
  );
  const hooks = await manager.executeHooks(span.id, ['syncBeforeRequestHook'], {
    env: { DESEARCH_API_KEY: apiKey },
  });
  const check = hooks.results[0]?.checks[0];
  assert(check && !check.error && check.transformed, 'Live search failed.');
  assert(check.data.sources.length > 0, 'Live search returned no sources.');
  assert(
    span.getContext().request.json.messages[0].content.includes('https://'),
    'Gateway did not apply the reference context.'
  );
  assert(
    !JSON.stringify(hooks).includes(apiKey),
    'Credential exposure detected.'
  );
  console.log(
    JSON.stringify({ live: 'PASS', sources: check.data.sources }, null, 2)
  );

  const canary = randomUUID();
  const failure = await handler(
    {
      requestType: 'complete',
      request: { json: { prompt: 'Portkey gateway documentation' } },
    },
    { credentials: { apiKey: canary } },
    'beforeRequestHook'
  );
  assert(failure.error && !failure.transformed, 'Canary key was not rejected.');
  assert(
    !JSON.stringify(failure).includes(canary),
    'Canary exposure detected.'
  );
  console.log('canary authentication failure: PASS (credential absent)');
}

main().catch(() => {
  // Do not print exceptions that could include request or credential values.
  console.error('Desearch smoke check failed (details suppressed).');
  process.exitCode = 1;
});
