# web-search-keyless

A `web_search` provider for DSH that works without a paid key by default, with a simple route to a paid API when you want one.

It registers a provider (`keyless-http`) with several engines, chosen in the config and tried in the order you list them:

| Engine | Needs a key | What it reads | Default |
|---|---|---|---|
| `duckduckgo` | no | the DuckDuckGo Instant Answer API (a public JSON endpoint) and the DuckDuckGo HTML results page | **on** |
| `bing` | no | the Bing HTML results page (scraping; **read the warning below**) | off |
| `brave` | **yes** | the [Brave Search API](https://brave.com/search/api/) (an official API with a free tier, check their current plans) | off |

Self-contained: no package imports, only the global `fetch`. It honours `AbortSignal`.

## Install

Copy `web-search-keyless.mjs` next to your `cordis.patch.yml`, then add:

```yaml
- insert:
    - id: web-search-keyless
      name: ./web-search-keyless.mjs
      config:
        engines: [duckduckgo]        # default. Others: bing (opt-in, see below), brave (needs a key)

- id: web
  config:
    searchProvider: keyless-http
    fetchProvider: http
```

Restart DSH (the setting takes effect at the next start). To go back to the hosted provider, change `searchProvider` back and delete the
`insert` block.

## The easy paid route: Brave Search API

1. Get an API key from Brave's search API page and put it in an **environment variable** (never in the config file):
   `BRAVE_SEARCH_API_KEY=...` (or any name, set with `braveApiKeyEnv`).
2. Put `brave` in the engine list. Listing it first means it is tried first and the others only fill in what is missing:

```yaml
      config:
        engines: [brave, duckduckgo]
        braveApiKeyEnv: BRAVE_SEARCH_API_KEY   # the name of the env var that holds the key
```

If `brave` is listed and the variable is empty, the plugin throws at start-up, so you see the mistake at once. The key is sent in a
request header, not in the URL, and the requests carry an honest `User-Agent` (`dsh-web-search-keyless`). Check Brave's current
terms and pricing yourself. The plugin is tested against a stubbed response, not against the live API.

## Turning Bing on (opt-in), and why it is off

```yaml
        engines: [duckduckgo, bing]
```

**Bing is off by default because it scrapes.** The plugin reads Bing's results page with a browser-style `User-Agent`, and Microsoft's
terms restrict automated access to its result pages. Read them before you enable it. It is meant for personal, low-volume use on your
own machine, you are responsible for how you use it, and it comes with no warranty (see the licence). Bing's page markup also changes
without notice, which then quietly returns fewer results. The DuckDuckGo HTML page is also a scraped page, so the same caution applies
to it, in a smaller way. If that bothers you, use only the Instant Answer API (a public endpoint) or an official API such as Brave's.

## Adding another provider

Add its name to `ENGINES`, a method that returns `[{ url, title, snippet }]`, and an entry in `byName` inside `search()`. Keep a keyed
engine opt-in, read its key from the environment, and send it in a header. `parseBraveResults` and its test show the pattern.

## Other things to know

- The page engines sometimes return a bot challenge instead of results. The plugin retries once after a short pause, and the instant
  answers do not depend on that. Treat the page engines as best-effort.
- Search results are text from the open web and reach your model as is. That is a prompt-injection surface, as with any search tool.
- Responses are cut at 2 million characters before parsing, requests time out after 8 seconds, and only `http` and `https` result
  links are kept.
- It is search only. Fetching a page is DSH's own `http` fetch provider.

## Tests

The helpers, the option checks, and which hosts each setting contacts (with `fetch` stubbed) have tests. The live search does not:

```
node --test web-search-keyless.test.mjs
```
