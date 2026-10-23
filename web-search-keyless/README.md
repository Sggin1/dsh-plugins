# web-search-keyless

A `web_search` provider for DSH that works without a paid key by default, with a simple route to a paid API when you want one.

It registers a provider (`keyless-http`) with several engines, chosen in the config and tried in the order you list them:

| Engine | Needs a key | What it reads | Default |
|---|---|---|---|
| `duckduckgo` | no | the DuckDuckGo Instant Answer API (a public JSON endpoint) and the DuckDuckGo HTML results page | **on** |
| `bing` | no | the Bing HTML results page (scraping; **read the warning below**) | off |
| `brave` | **yes** | the [Brave Search API](https://brave.com/search/api/) (an official API with a key; plans, quotas and prices change, and a free plan may not be offered to new accounts, so check their current pricing) | off |

**Recommended: use an official API (Brave) for anything beyond casual use.** The keyless default reads public pages and is best-effort;
an API gives you stable results and clear terms. See [the Brave route](#the-easy-paid-route-brave-search-api) below.

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

1. Get an API key from Brave's search API page (read the plan's monthly quota and per-second limit first) and put it in an **environment variable** (never in the config file):
   `BRAVE_SEARCH_API_KEY=...` (or any name, set with `braveApiKeyEnv`).
2. Put `brave` in the engine list. Engines run in the order listed, so with `brave` first the other engines only fill in what is missing
   (when `duckduckgo` is listed, its Instant Answer is also added alongside the results):

```yaml
      config:
        engines: [brave, duckduckgo]
        braveApiKeyEnv: BRAVE_SEARCH_API_KEY   # the name of the env var that holds the key
```

If `brave` is listed and the variable is empty, the plugin throws at start-up, so you see the mistake at once. The key is sent in a
request header, not in the URL, and the requests carry an honest `User-Agent` (`dsh-web-search-keyless`). Check Brave's current
terms and pricing yourself.

**When Brave cannot answer**, the model is told why instead of seeing an empty search: a rejected key (HTTP 401, 403 or 422), a rate
limit or exhausted quota (429), or any other status produces a line such as `Search note: Brave rejected the request (HTTP 401) ...`
when no engine returned results. A 429 is retried once after about a second, because plans often allow one request per second.
Brave is called once per search, and a second time only after a 429. A page-engine retry never calls Brave again. The key must be plain
visible characters (no spaces or control characters), otherwise the plugin refuses to load and does not print the value. The Brave
request does not follow redirects, so the key header cannot be sent to another host.

**A monthly cap of your own**, so a runaway agent cannot use up the plan:

```yaml
      config:
        engines: [brave, duckduckgo]
        braveMonthlyCap: 250      # optional; stop using Brave once this many searches are used this month
```

The cap uses the usage Brave reports in its rate-limit headers (two values each, "per second, per month"), so there is no counter file
and a restart simply learns the usage again from the next reply. Brave's count can lag by a request, so the cap is approximate. When
the cap is reached, Brave is skipped until the quota window resets and the next engine in your list answers; the note about the cap is
shown only when nothing else produced results. If the headers are missing or in another shape, no cap is enforced (the plan's own
limit still applies). Raise or remove `braveMonthlyCap` at any time.

The plugin's tests use a stubbed `fetch`. It was also run once against the live API with a real key (the header format above comes from
that run); nothing in the test suite spends quota.

## Turning Bing on (opt-in), and why it is off

```yaml
        engines: [duckduckgo, bing]
```

**Bing is off by default because it scrapes.** The plugin reads Bing's results page with a browser-style `User-Agent`, and Microsoft's
terms restrict automated access to its result pages. Read them before you enable it. It is meant for personal, low-volume use on your
own machine, you are responsible for how you use it, and it comes with no warranty (see the licence). Bing's page markup also changes
without notice, which then quietly returns fewer results. The DuckDuckGo HTML page is also a scraped page, so the same caution applies
to it, in a smaller way. If that bothers you, use only the Instant Answer API (a public endpoint) or an official API such as Brave's.

What was checked (October 2026): DuckDuckGo's terms contain no language about automated access and ask users to use its services "as
authorized." The Acceptable Use Policy they link to could not be read when checked, so whether scraping the HTML results page is
permitted is unverified. The Instant Answer and Brave options avoid the question.

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
