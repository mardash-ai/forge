# Forge Repository Structure

> The repository implements the architecture.
>
> It does not define the Domain Model.

The repository should make the architecture obvious.

A contributor should know where code belongs by understanding whether it defines a Capability, Resource, Event, Policy, Permission, Implementation, Plugin, or interface.

## Top-Level Structure

```text
forge/
├── capabilities/
├── resources/
├── events/
├── policies/
├── permissions/
├── goals/
├── core/
├── plugins/
├── interfaces/
│   ├── cli/
│   ├── ui/
│   └── sdk/
├── agents/
├── docs/
└── tools/
```

## capabilities/

Defines what Forge can do.

Examples:

```text
capabilities/
├── build/
├── test/
├── deploy/
├── evaluate/
├── search/
├── analyze/
├── plan/
└── generate/
```

Each Capability defines:

- contract
- input schema
- output Resource type
- emitted Events
- required Permissions
- applicable Policies
- Implementation selection rules

## resources/

Defines durable state.

Examples:

```text
resources/
├── workspace/
├── build/
├── test_run/
├── deployment/
├── evaluation/
├── artifact/
├── environment/
├── release/
└── incident/
```

Each Resource defines:

- schema
- lifecycle
- allowed state transitions
- relationships
- permissions
- emitted Events

Resources do not contain provider-specific logic.

## events/

Defines immutable facts.

Examples:

```text
events/
├── build_events/
├── deployment_events/
├── evaluation_events/
└── artifact_events/
```

Events should be stable, explicit, and auditable.

## policies/

Defines governance rules.

Policies evaluate Builders, Goals, Capabilities, Resources, Events, and context.

Policies do not perform work.

## permissions/

Defines authorization relationships.

Permissions decide whether a Builder may invoke a Capability or access a Resource.

## goals/

Defines Goal tracking when Forge needs to represent higher-level outcomes.

Goals are not commands.

Goals may decompose into Capability execution through planning and workflow composition.

## core/

The core coordinates Forge.

It owns:

- Capability routing
- Resource lifecycle
- Event publication
- Policy evaluation
- Permission checks
- Implementation selection
- workflow composition
- audit trails

The core should remain small and stable.

## plugins/

Plugins package replaceable Implementations.

Examples:

```text
plugins/
├── build/
│   ├── bazel/
│   └── buck2/
├── test/
│   ├── jest/
│   └── playwright/
├── deploy/
│   └── kubernetes/
└── llm/
    ├── openai/
    └── anthropic/
```

Plugins exist only at technology boundaries.

## interfaces/

Interfaces expose Forge to Builders.

Examples:

- CLI
- UI
- SDK

Interfaces call Capability and Resource APIs.

Interfaces do not bypass the core.

## agents/

Agents are Builders implemented in software.

Agents use the same APIs as humans.

Agent-specific code belongs here only when it defines first-party agent behavior.

Platform capabilities do not belong inside agents.

## docs/

Documentation is part of the system.

Recommended structure:

```text
docs/
├── 00_FORGE_SPECIFICATION_V1.md
├── 01_FORGE_MANIFESTO.md
├── 02_FORGE_DOMAIN_MODEL.md
├── 03_FORGE_LAWS.md
├── 04_FORGE_ARCHITECTURE.md
├── 05_FORGE_API_PHILOSOPHY.md
├── 06_FORGE_REPOSITORY.md
├── 07_FORGE_PLAYBOOK.md
└── adr/
```

Every major Architecture Decision Record should cite the Domain Model and Laws it depends on.

## Adding a Capability

1. Define the Capability contract.
2. Define the Resource it creates or modifies.
3. Define Events it emits.
4. Define Policy and Permission requirements.
5. Add one concrete Implementation.
6. Add Plugin packaging only if the Implementation crosses a technology boundary.
7. Expose through interfaces.
8. Add agent usage only through the same APIs.

## Adding a Resource

1. Define schema.
2. Define lifecycle.
3. Define relationships.
4. Define permissions.
5. Define emitted Events.
6. Define which Capabilities may create or modify it.

## Adding an Implementation

1. Identify the Capability it implements.
2. Keep provider-specific logic inside the Implementation.
3. Do not change the Builder-facing Capability unless the contract is wrong.
4. Package as a Plugin if the technology boundary must remain replaceable.

## Repository Health Test

Before merging, ask:

- Is this a domain concept or architecture concept?
- Does it belong in capabilities, resources, events, policies, permissions, goals, core, plugins, interfaces, or agents?
- Did we introduce behavior into a Resource?
- Did we introduce state into a Capability?
- Did we leak Implementation details into the API?
- Did we create a Plugin where no technology boundary exists?
- Does this help Builders build?

## In One Sentence

The Forge repository separates behavior, state, facts, governance, authorization, implementations, and interfaces so the platform can evolve without confusing its own model.
