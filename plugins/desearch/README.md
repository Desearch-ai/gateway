# Desearch web search

The `desearch.online` before-request transformer adds ranked web titles, URLs and
snippets to chat or completion requests. It calls the `web-search` tool on the
[hosted Desearch MCP server](https://www.desearch.ai/docs/guide/sdk/mcp) at
`https://mcp.desearch.ai/mcp`. It does not call the search REST API or run a model.
The adapter uses MCP Streamable HTTP protocol `2025-03-26` with JSON or SSE
responses. Your Desearch balance is charged for successful searches according to
your plan. The request's last user text (or completion prompt) is sent to Desearch.

## Enable in a source checkout

Use Node **20.19.0**, npm **10.8.2**, and the repository lockfile. From the repository
root, install dependencies and add `desearch` to your local enabled plugins:

```sh
npm ci
node --input-type=module -e 'import fs from "node:fs"; const p="conf.json"; const c=JSON.parse(fs.readFileSync(p,"utf8")); c.plugins_enabled=[...new Set([...c.plugins_enabled,"desearch"])]; fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");'
npm run build-plugins
npm run build
```

Keep credentials out of `conf.json`, generated files, and source control. Supply
your user-configured key through the hook execution environment's
`DESEARCH_API_KEY`, or through `parameters.credentials.apiKey` in your secure
server-side configuration. Explicit credentials take precedence over the environment.
Only pass a trusted environment to the hook runner; this plugin does not read
`process.env` itself. The smoke runner below forwards its environment explicitly.

Add this hook to your Gateway request configuration:

```json
{
  "before_request_hooks": [
    {
      "id": "web-context",
      "type": "mutator",
      "checks": [
        {
          "id": "desearch.online",
          "parameters": {
            "numResults": 5,
            "timeout": 30000
          }
        }
      ]
    }
  ]
}
```

`numResults` is an integer from 1 to 10 (default 5), applied locally to the first
page returned by MCP. It does not request additional pages. `timeout` is the total
initialize/notification/search budget in milliseconds, from 1 to 60000 (default
30000). The endpoint is fixed and redirects are rejected.

For `chatComplete`, the plugin searches the last user message's text parts and
appends reference context to an existing string system message, or inserts a new
system message. Images and the original messages are preserved. For `complete`,
it prepends reference context to a single string prompt. Empty text, batch prompts,
and queries over 8000 characters return a sanitized error. Other request types
and after-request hooks are skipped. Up to 500 title characters and 2000 snippet
characters per result are included. Unsafe or malformed URLs are discarded.

Search results are labeled as untrusted reference data. On no results, the
request is unchanged. On authentication, timeout, protocol or provider failure,
the hook returns a fixed error and leaves the request unchanged. This transformer
is fail-open (`verdict: true`); do not use it as a mandatory evidence gate.
It does not log credentials, upstream error bodies, or MCP session identifiers.

## Verify

Offline tests need no key:

```sh
npx jest plugins/desearch/desearch.test.ts --runInBand
npx prettier --check plugins/desearch
```

With the plugin registry generated above and `DESEARCH_API_KEY` already supplied
securely in your shell environment, run:

```sh
npx tsx plugins/desearch/smoke.ts
```

The smoke check runs a real search through the Gateway's `HooksManager`, verifies
that reference context reaches the request, and prints public source metadata.
It then uses an ephemeral invalid key to verify sanitized authentication failure.
It does not invoke an LLM provider. A failure prints a fixed message and exits
nonzero. Never paste a real key into a command, config file or test fixture.
