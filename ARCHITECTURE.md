# Architecture & Style

This documents practical principles we follow in the Cody
client. These principles help sustain Cody for long term success.

Please contribute! It's preferable to use abstractions and tools to
encode these principles, but this doc can help until the automation is
done.

## Contents

* [Style](#style)
* [Telemetry](#telemetry)
* [Token Counting](#token-counting)

## Style

The following guidelines are not exhaustive. Please contribute if you see the same issue over and
over in code review.

### Documentation

- **Do** document "API" methods with `/**`-style doc comments. An "API" method is one that is 
re-exported by a library, for example from within `lib/shared` to other libraries through re-exports
in `lib/shared/src/index.ts`.
- Feel free to document other methods with comments, but this is not mandatory.
- **Do not** write `/**`-style comments in the middle of function bodies.

### Type Safety

**Avoid `as` outside test code:** It is not a checked cast, it is an assertion that turns off
TypeScript's type checking. Any inaccuracies in the type you are asserting can ripple out to create
difficult to diagnose bugs elsewhere. Use the TypeScript type system: it is far better because it is
checked now **and** with every change that comes *after* yours.

If you want the type checker to ensure that an expression conforms to a type, use
[`satisfies`.](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator)

`as` may be ok in test code, where it doesn't pose a systemic risk to evolving the codebase. But
still try to avoid it.

### When to use Values, Promises, Observables and Callbacks

- For methods that produce a single result synchronously, simply return a value.
- For methods that produce a single asynchronous result, return a Promise. If the method has no arguments or side effects, consider a property that is a Promise.
- For methods where the caller should keep up to date with a changing value, use an Observable.
- For methods that produce multiple values which should be pulled by the caller (demand driven), use a generator (`function*`).
- For discrete events, multiplexed to multiple subscribers, use the event listener pattern.
- For more complicated protocols, consider using callbacks.

These more complicated protocols include:
- Values must be pushed by the callee (supply driven) and handled synchronously. For example, the API operates with a filter and needs a result; the API needs to enforce the ordering of a cleanup operation.
- When there are multiple kinds of callbacks that don't fit neatly into Promise resolve/reject, Observable next/error, etc. For example a network connection may have different lifecycle events like connect, header, body, closed, errored, etc.

## Telemetry

To improve Cody, we record some events as people use Cody.

### Principles

- Add enough Telemetry events for us to understand how Cody is used.
- Event naming:
  - Name your event "feature" parameter `cody.<feature>`. Do not include the client name in the event feature.
  - Use the "action" parameter to indicate a verb corresponding to an event. Do not include event verbs in the "feature" parameter.
- Event metadata:
  - Design your events around numeric values, not arbitrary strings. Understand "sensitive" data and use `privateMetadata` to protect it. (See below.)
- In VSCode, write e2e tests with `.extend<ExpectedV2Events>({ ...` to test your events are firing. Grep the codebase for examples.
- When handling transcripts in Telemetry:
  - Transcript data can only be collected through V2 Telemetry and must be stored within the `privateMetadata` argument of the event
  - Transcript data should be stored as top-level fields within `privateMetadata`, using the keys `promptText` or `responseText`
  - Transcript data must include `recordsPrivateMetadataTranscript:1` in the safe `metadata` argument of the event
  - Transcript data can only be collected for DotCom (Free) Users
- Do not create wrappers around the `TelemetryRecorder` types exported from `lib/shared/src/telemetry-v2` - the exported interfaces implement type checks that intentionally make it harder to accidentally record sensitive data in safe `metadata`.

### Rationale

All Cody events use [Sourcegraph's new telemetry events framework](https://sourcegraph.com/docs/dev/background-information/telemetry). Events primarily comprise of:

1. `feature`, a string denoting the feature that the event is associated with.
   1. **All events must use a `feature` that starts with `cody.`**, for example `cody.myFeature`
   2. The feature name should not include the name of the extension, as that is already included in the event metadata.
2. `action`, a string denoting the action on the feature that the event is associated with, typically a verb.
3. `parameters`, which includes safe numeric `metadata` and [unsafe arbitrarily-shaped `privateMetadata`](https://sourcegraph.com/docs/dev/background-information/telemetry#sensitive-attributes).

Extensive additional context is added by the extension itself (e.g. extension name and version) and the Sourcegraph backend (e.g. feature flags and actor information), so the event should only provide metadata about the specific action. Learn more in [events lifecycle](https://sourcegraph.com/docs/dev/background-information/telemetry#event-lifecycle).

```ts
// New events client
import { telemetryRecorder } from "@sourcegraph/cody-shared";

// Equivalent in the new instrumentatiom
telemetryRecorder.recordEvent("cody.fixup.apply", "succeeded", {
  metadata: {
    /**
     * metadata, exported by default, must be numeric.
     */
    lineCount: codeCount.lineCount,
    charCount: codeCount.charCount,
  },
  privateMetadata: {
    /**
     * privateMetadata is NOT exported by default, because it can accidentally
     * contain data considered sensitive. Export of privateMetadata can be
     * enabled serverside on an allowlist basis, but requires a Sourcegraph
     * release.
     *
     * Where possible, convert the data into a number representing a known
     * enumeration of categorized values instead, so that it can be included
     * in the exported-by-default metadata field instead.
     *
     * Learn more: https://sourcegraph.com/docs/dev/background-information/telemetry#sensitive-attributes
     */
    source,
  },
});
```

When events are recorded, `telemetryRecorder` will make sure the connected instance receives the event in the new framework, if the instance is 5.2.0 or later, or translated to the legacy `event_logs` format, if the instance is older.
   1. In instances 5.2.1 or later, the event will [also be exported from the instance](https://sourcegraph.com/docs/dev/background-information/telemetry/architecture).

Allowed values for various fields are declared and tracked in [`lib/shared/src/telemetry-v2`](../lib/shared/src/telemetry-v2).

## Token Counting

LLMs convert text input into tokens and apply limits and billing based
on token counts. This is why token counts are important.

### Principles

When counting tokens, follow these principles:

- Express limits in tokens, not characters.

- Apply limits after a model is chosen. An accurate token count
  depends on the specific tokenizer a model uses.

- When possible, count tokens after appending strings instead of
  counting tokens in each string and summing the counts. This produces
  a more accurate token count.

- If accurate token counting becomes a performance bottleneck, reach
  out for help with algorithms to balance performance and accuracy.

### Rationale

Different LLMs use different tokenizers, so the same string may
produce different token counts in different models. Tokens can span
multiple characters. Some characters can span multiple tokens.

This means accurate token counting is a function of the input string
and the model's tokenizer:

> *countTokens(inputString, tokenizer) &rarr; number*

Cody clients used a heuristic of "4 characters per token" and
conservative token limits, but this heuristic can be off by a factor
of 4x or more, for example, for Japanese.

By the way,

> *countTokens(s1, tok) + countTokens(s2, tok) &neq; countTokens(s1 + s2, tok)*

In practice it is OK to assume token counts sum, but errors will
accumulate the more strings you append.
