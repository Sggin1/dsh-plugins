# dsh-plugins

Small plugins for DSH, written while running local model servers.
Each folder is one plugin with its own README and tests (`node --test <folder>/<name>.test.mjs`, Node 22).

| Plugin | What it does |
|---|---|
| [`serve-pull`](serve-pull/) | Models that a local control plane ("serve") is running show up in DSH as providers by themselves, and go when they stop. |
| [`web-search-keyless`](web-search-keyless/) | A `web_search` provider that needs no API key (DuckDuckGo and Bing pages, best effort). |
| [`tool-call-flood-guard`](tool-call-flood-guard/) | Stops a looping model from flooding the context: an identical tool call runs once per reply, repeats across replies are capped, and a turn has a step budget. |

## Installing a plugin

1. Copy the plugin's `.mjs` file into your DSH profile folder (next to your `cordis.patch.yml`).
2. Add an `insert` block for it to `cordis.patch.yml` (each plugin's README has a copy-paste example).
3. Restart DSH.

All three plugins use named exports only (the loader does `exports.default ?? exports`) and can be removed by deleting their block
from the config. On bad config, `tool-call-flood-guard` throws at load; `serve-pull` falls back to its defaults and skips entries it
cannot use, and `web-search-keyless` has no config.

"serve" in `serve-pull` is the author's own local control plane for LLM inference servers; it is not published. The plugin only needs
an endpoint that returns the JSON shape described in its README, so it works with anything that provides one.

## Status

Written for a personal setup and shared as is. Tested with the unit tests in each folder; not tested against every DSH version.
Check the DSH version you run before using them.
