# web-search-keyless

A `web_search` provider for DSH that needs no API key.

The base bundle's search provider calls a paid hosted API. This plugin registers a second provider (`keyless-http`) that reads public
search endpoints directly with plain `fetch`:

1. DuckDuckGo Instant Answer API (entities and instant answers; JSON, no auth).
2. DuckDuckGo HTML results page (result lists).
3. Bing HTML results page (result lists).

Self-contained: no package imports, only the global `fetch`. It honours `AbortSignal`.

## Install

Copy `web-search-keyless.mjs` next to your `cordis.patch.yml`, then add:

```yaml
- insert:
    - id: web-search-keyless
      name: ./web-search-keyless.mjs

- id: web
  config:
    searchProvider: keyless-http
    fetchProvider: http
```

Restart DSH (the setting takes effect at the next start). To go back to the hosted provider, change `searchProvider` back and delete the
`insert` block.

## Read this before using it

- **The result lists come from scraping search pages**, not from an official API (only the Instant Answer endpoint is one). Those pages
  can change their markup at any time, and they sometimes return a bot challenge instead of results. The plugin retries once after a short
  pause, and the instant answers do not depend on that. Treat the list engines as best-effort.
- It sends a browser-style `User-Agent`, because bare machine user agents get throttled quickly. Check the terms of the search engines you
  point it at, and use it at a low volume.
- It is search only. Fetching a page is DSH's own `http` fetch provider.

## Tests

None yet. A syntax check: `node --check web-search-keyless.mjs`.
