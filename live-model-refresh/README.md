# live-model-refresh

Keeps each model provider's list fresh in DSH and shows whether its endpoint is answering.

DSH's own green dot in the Models settings means "route registered", not "endpoint answering", so a server that is switched off still
reads green. This plugin probes the endpoints and puts the answer in the one field the list shows.

Every 30 s, for each `llm-pi-ai` provider that has a `baseURL` and an `api` of `openai-completions`, `openai-responses` or
`anthropic-messages`, it:

- asks DSH to discover the models the endpoint serves and **merges new ones** into the provider's `models` (entries you already have,
  with your edits, are kept as they are);
- sets a `  [up]` or `  [down]` marker on the provider's `displayName`, only when it already has one, and only when the state changes;
- sets `transport: sse` on every provider that has a `baseURL` and no `transport` yet (once), **whatever its `api`**: this step is not limited
  to the three `api` values above.

Writes go through DSH's own settings API (`settings.mutate`), so DSH keeps your file's comments.

## Things to know before you turn it on

- It **rewrites settings**: `displayName` gains a marker and `transport` may be set. Remove the plugin and the markers stay until you edit them out.
- It probes **every** eligible provider's `baseURL`, including hosted ones, every 30 s. If you do not want a provider probed, give it an `api`
  value outside the three above (the `transport` write above still reaches that provider).
- The poll interval (30 s) is a constant in the file.
- It has no automated tests; the other three plugins in this repo do.

## Install

Copy `live-model-refresh.mjs` next to your `cordis.patch.yml` and add:

```yaml
- insert:
    - id: live-model-refresh
      name: ./live-model-refresh.mjs
```

Then restart DSH. It uses named exports only, as the loader requires.
