# Forge Architecture

> Architecture explains how Forge realizes the Domain Model.

The Domain Model defines the problem language.

Architecture defines the solution structure.

Do not mix them.

## Architectural Center

Forge realizes the Domain Model through this architecture:

```text
Builder Interface
    ↓
Capability API
    ↓
Capability Runtime
    ↓
Implementation
    ↓
Resource Store
    ↓
Event Stream
```

## Domain to Architecture Mapping

| Domain Concept | Architectural Realization |
|---|---|
| Builder | Human user, agent, service principal |
| Goal | Goal record, planning context, task context |
| Capability | API-exposed platform operation |
| Resource | Durable state object |
| Event | Immutable event record |
| Policy | Policy engine rule |
| Permission | Authorization relationship |

## Capabilities

Capabilities are the architectural boundary for behavior.

Every meaningful action in Forge is modeled as a Capability.

Examples:

- Build
- Test
- Deploy
- Evaluate
- Search
- Analyze
- Plan
- Generate

Capabilities are stable contracts.

They hide Implementations.

## Implementations

An Implementation performs a Capability using specific technology.

Examples:

- Bazel implementation of Build
- Buck2 implementation of Build
- Jest implementation of Test
- Playwright implementation of Test
- Kubernetes implementation of Deploy
- OpenAI implementation of Generate
- Anthropic implementation of Analyze

Implementations are replaceable.

Implementations do not define the Builder experience.

## Plugins

A Plugin packages one or more Implementations.

Plugins exist at technology boundaries.

Use Plugins for:

- build systems
- test frameworks
- deployment targets
- model providers
- source control providers
- identity providers
- runtime providers

Do not use Plugins for business logic.

Do not use Plugins for speculative abstraction.

Do not create a Plugin unless technology changes.

## Resources

Resources are the durable state model of Forge.

Every Resource has:

- identity
- type
- state
- lifecycle
- relationships
- ownership
- permissions
- history
- Events

Resources do not call Plugins.

Resources do not own behavior.

Capabilities create or modify Resources.

## Events

Events are the history of Forge.

Events are emitted when Resources change or meaningful platform facts occur.

Events enable:

- observability
- automation
- replay
- auditing
- agent awareness
- integration

Events are facts, not commands.

## Policies and Permissions

Policies decide whether something is allowed.

Permissions decide whether a Builder may act.

Policy and permission checks happen before Capability execution and may also occur during Resource transitions.

## Workflow Composition

A Workflow is architectural composition.

It is not a domain primitive.

A Workflow composes Capabilities to satisfy a Goal.

Example:

```text
Plan
  → Build
  → Test
  → Evaluate
  → Deploy
  → Observe
```

Workflow composition should be explicit.

Do not hide critical behavior in Plugins.

## The Core

The Forge core owns:

- Capability routing
- Resource lifecycle
- Event publication
- Policy evaluation
- Permission checks
- Implementation selection
- workflow composition
- auditability

The core should be boring.

The core should be stable.

The core should not know the details of Bazel, Kubernetes, OpenAI, or any other provider.

## Architecture Rule

> Capabilities expose behavior. Resources represent state. Implementations perform work. Plugins package implementations. Events record facts. Policies govern. Permissions authorize.

When architecture becomes unclear, return to this sentence.
