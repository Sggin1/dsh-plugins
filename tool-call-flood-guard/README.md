# tool-call-flood-guard

Stops a looping model from flooding the context with tool calls.

A model that degenerates inside one reply can emit the same tool call hundreds of times. DSH runs every call, the results fill the
context window in a single step, and the session overflows before compaction can act. This plugin is a `tools/pre-execute` listener:
calls reach it in model order, before dispatch and before any approval prompt.

## What it limits

Within one assistant step:
- an identical call (same tool, same arguments, key order ignored) runs once; later copies are denied with a one-line reason;
- at most `maxCallsPerStep` calls run; the rest are denied.

Across steps of one turn (a slow loop slips past the per-reply limits):
- the same call is denied once it has run `maxIdenticalAcrossSteps` times within the last `window` calls;
- after `maxStepsPerTurn` model steps, every further tool call is denied with a wrap-up message, so the agent has to answer.

A denial becomes a short error result, so every model call still gets exactly one result and the session log replays normally.

## Config

```yaml
- insert:
    - id: tool-call-flood-guard
      name: ./tool-call-flood-guard.mjs
      config:
        maxCallsPerStep: 32          # default 64
        maxIdenticalPerStep: 1       # default 1
        maxIdenticalAcrossSteps: 4   # default 4
        window: 12                   # default 12 (calls remembered per turn)
        maxStepsPerTurn: 60          # default 60; 0 turns the step budget off
```

All fields are optional. Bad values throw at load.

Pick `maxCallsPerStep` from your own sessions: count tool calls per reply and set the limit above what normal replies use. Replies that
hit the output-token cap with repeated calls are the runaways this is for.

## Tests

```
node --test tool-call-flood-guard.test.mjs
```
