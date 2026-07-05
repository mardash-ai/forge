# Forge API Philosophy

> APIs expose Forge's Domain Model through stable architectural contracts.

Forge APIs are designed for both humans and agents.

A human may use a UI.

An agent may call an API.

Both operate on the same platform.

## APIs Expose Capabilities and Resources

Forge has two primary API surfaces:

1. **Capability APIs** — perform behavior.
2. **Resource APIs** — expose state.

Events, Policies, and Permissions support those surfaces.

## Capability APIs

Capability APIs ask Forge to do something.

Examples:

```text
POST /capabilities/build
POST /capabilities/test
POST /capabilities/evaluate
POST /capabilities/deploy
```

A Capability API should express platform behavior, not implementation detail.

Good:

```text
Build
Deploy
Evaluate
```

Bad:

```text
Run Bazel
Apply Kubernetes YAML
Call GPT-5
```

## Resource APIs

Resource APIs expose state.

Examples:

```text
GET /resources/builds/{id}
GET /resources/deployments/{id}
GET /resources/evaluations/{id}
GET /resources/artifacts/{id}
```

Resources are durable.

Resources have lifecycle.

Resources emit Events.

## Goals in APIs

A Goal is the source of work.

Goals may be represented when Forge needs to track higher-level outcomes.

Example:

```text
POST /goals
GET /goals/{id}
```

A Goal may produce many Capability executions and many Resources.

Do not model every action as a Goal.

## Synchronous vs Asynchronous

Return synchronously when the answer is immediate.

Create a Resource when work is long-running.

Example:

```text
POST /capabilities/build
→ 202 Accepted
→ Build Resource
```

The caller observes Resource state and Events.

Do not block on long-running work.

## Idempotency

Builders retry.

Agents retry.

Networks fail.

Every mutating API should support idempotency unless impossible.

Retries should be safe by default.

## Discoverability

Agents must be able to discover Forge.

Capability APIs should expose:

- name
- description
- schema
- required permissions
- Resource types produced
- Events emitted
- Policies that may apply
- examples

Documentation explains.

Discovery enables.

## Errors

Errors are part of the API.

A good error tells a human:

- what happened
- why it happened
- how to fix it

A good error tells an agent:

- whether to retry
- whether input must change
- whether human judgment is required

## Events

Events are not API responses.

Events are facts.

They should be queryable, subscribable, and auditable.

Events allow Builders and agents to understand how Resources changed over time.

## Policy and Permission Visibility

APIs should make governance explainable.

When an operation is blocked, Forge should explain:

- which Policy applied
- which Permission was missing
- what Builder action is required
- whether escalation is possible

## API Design Test

Before approving an API, ask:

- Does it expose a Capability or a Resource?
- Does it hide Implementation details?
- Can a human and agent use the same contract?
- Is long-running work represented as Resource state?
- Are Events emitted?
- Are Policies and Permissions explainable?
- Is the API discoverable?
- Is retry safe?

If not, keep designing.

## In One Sentence

Forge APIs expose Capabilities as behavior and Resources as state so humans and agents can use the same platform while Implementations remain replaceable.
