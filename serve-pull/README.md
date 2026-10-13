# serve-pull

Models a local control plane is running appear in DSH as providers by themselves, and disappear when they stop.

Every `pollMs` (default 10 s) the plugin asks the control plane which servers are up (`GET <serveUrl>/api/harness/dsh`) and makes the
`serve-*` providers in DSH's `llm-pi-ai` settings match: new ones are added, changed ones updated, ones no longer running removed.

- Only providers whose key starts with `serve-` are ever touched. Hand-made providers (openrouter, your own) are left alone.
- If the control plane does not answer, **nothing changes**.
- Writes go through DSH's own settings API (`settings.mutate`), so DSH keeps your file's comments and there is no second writer.

## What the endpoint must return

```json
{ "entries": [ {
    "key": "serve-my-model-default",
    "displayName": "My model",
    "baseURL": "http://127.0.0.1:8080/v1",
    "modelId": "the-id-the-server-reports",
    "contextWindow": 131072,
    "maxTokens": 32768,
    "input": ["text"],
    "reasoningEfforts": { "off": null, "low": "low", "high": "high" },
    "thinkingFormat": "qwen-chat-template"
} ] }
```

`reasoningEfforts` and `thinkingFormat` are optional (a model that thinks). `contextWindow` should be the limit the server really
enforces: if it is larger, DSH can send requests the server rejects.

## Config

```yaml
- insert:
    - id: serve-pull
      name: ./serve-pull.mjs
      config:
        serveUrl: http://127.0.0.1:7070   # where the control plane listens
        apiKeyEnv: YOUR_LOCAL_API_KEY_ENV # an env var DSH requires on a provider; any value works for a local server
        pollMs: 10000
```

To remove it, delete this block and the `serve-*` providers.

## Notes

- A server that rejects the `developer` role (some chat templates only know `system`) answers 400 to clients that send it. That is a
  server-side template issue, not this plugin.

## Tests

```
node --test serve-pull.test.mjs
```
