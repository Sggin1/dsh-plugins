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
- **Scraping may break a search engine's terms of service**, Bing's in particular, which restrict automated access to its result pages.
  The plugin sends a browser-style `User-Agent` because bare machine user agents get throttled quickly. It is meant for personal,
  low-volume use on your own machine. You are responsible for how you use it, and it comes with no warranty (see the licence).
  If that is a concern, do not install it, or edit it to use only the DuckDuckGo Instant Answer API, which is a public endpoint.
- Search results are text from the open web and reach your model as is. That is a prompt-injection surface, as with any search tool.
- Responses are cut at 2 million characters before parsing, requests time out after 8 seconds, and only `http` and `https` result
  links are kept.
- It is search only. Fetching a page is DSH's own `http` fetch provider.

## Tests

The pure helpers (entity decoding, text cleaning) have tests; the network search itself does not:

```
node --test web-search-keyless.test.mjs
```
