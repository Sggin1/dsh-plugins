# dsh-plugins

Small plugins for [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness), written while running local model servers.
These are independent community plugins, not part of DSH or affiliated with its authors.
Each folder is one plugin with its own README and tests (`node --test <folder>/<name>.test.mjs`, Node 22).

| Plugin | What it does |
|---|---|
| [`serve-pull`](serve-pull/) | Models that a local control plane ("serve") is running show up in DSH as providers by themselves, and go when they stop. |
| [`web-search-keyless`](web-search-keyless/) | A `web_search` provider that needs no paid key by default (DuckDuckGo), with Bing (scraping, opt-in) and the Brave Search API (keyed, opt-in) as options. |
| [`tool-call-flood-guard`](tool-call-flood-guard/) | Stops a looping model from flooding the context: an identical tool call runs once per reply, repeats across replies are capped, and a turn has a step budget. |

## Installing a plugin

1. Copy the plugin's `.mjs` file into your DSH profile folder (next to your `cordis.patch.yml`).
2. Add an `insert` block for it to `cordis.patch.yml` (each plugin's README has a copy-paste example).
3. Restart DSH.

All three plugins use named exports only (the loader does `exports.default ?? exports`) and can be removed by deleting their block
from the config. On bad config, `tool-call-flood-guard` throws at load; `serve-pull` falls back to its defaults and skips entries it
cannot use, and `web-search-keyless` throws at load on an unknown engine or a missing API key.

"serve" in `serve-pull` is the author's own local control plane for LLM inference servers; it is not published. The plugin only needs
an endpoint that returns the JSON shape described in its README, so it works with anything that provides one.

## Questions, bugs and security

Questions and bug reports: open an issue. For a security problem, see [SECURITY.md](SECURITY.md) and report it privately.

## Status

Written for a personal setup and shared as is. Tested with the unit tests in each folder; not tested against every DSH version.
Check the DSH version you run before using them.
