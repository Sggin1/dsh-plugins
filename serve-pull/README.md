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

## What it checks, and what it trusts

- An entry is only written if it has a display name, a model id, an `http://` or `https://` base URL, and positive whole-number
  `contextWindow` and `maxTokens`. An invalid entry is skipped, and a provider that already exists under its key is left as it is.
- A response bigger than 1 MB, a non-JSON body, or a body without an `entries` list changes nothing.
- **An empty list (`"entries": []` from a healthy endpoint) removes every `serve-*` provider.** That is how a stopped server disappears.
  An endpoint that cannot be reached changes nothing.
- It sends whatever base URL the endpoint gives to DSH as a provider, and DSH then sends prompts there. **Only point `serveUrl` at an
  endpoint you trust.** Redirects are followed by `fetch`'s default behaviour.
- Bad config values fall back to the defaults (`serveUrl` `http://127.0.0.1:7070`, `pollMs` 10000); they do not throw. `pollMs` is kept
  between 1000 (one second) and 3600000 (one hour).
- Optional entry fields are checked too: `input` may only list `text` and `image`, `thinkingFormat` must be a short string, and
  `reasoningEfforts` values must be short strings or null. An entry that fails any check is skipped.

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
