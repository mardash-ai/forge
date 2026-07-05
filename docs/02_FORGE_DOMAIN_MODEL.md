# Forge Domain Model

> The Domain Model defines the canonical language of Forge.

The Domain Model contains only concepts that describe software creation itself.

It does not describe implementation.

It does not describe plugins.

It does not describe repository layout.

Those belong to architecture.

## The Seven Domain Concepts

Forge has seven irreducible domain concepts.

| Concept | Question |
|---|---|
| Builder | Who creates software? |
| Goal | Why does the work exist? |
| Capability | What can Forge do? |
| Resource | What state exists? |
| Event | What happened? |
| Policy | Is it allowed? |
| Permission | Who may act? |

Everything else is architecture, runtime, or implementation detail.

## Canonical Model

```text
Builder
  pursues
Goal

Goal
  requires
Capability

Capability
  creates or modifies
Resource

Resource
  emits
Event

Policy
  governs
Builder, Goal, Capability, Resource, and Event

Permission
  authorizes
Builder against Capability or Resource
```

## Builder

A Builder is an actor that creates software.

A Builder may be human, agent, service, or system acting on behalf of another Builder.

A Builder is not a job title.

A Builder is not synonymous with engineer.

A Builder is anyone or anything that participates in creating software.

## Goal

A Goal is the desired outcome.

Examples:

- Add support for 8K video uploads.
- Reduce checkout latency below 500ms.
- Safely release version 142 to production.
- Investigate the production regression.
- Improve test coverage for the payment service.

A Goal explains why work exists.

A Goal is not a command.

A Goal is not a workflow.

A Goal may require many Capabilities.

## Capability

A Capability is something Forge can do.

Examples:

- Plan
- Build
- Test
- Evaluate
- Deploy
- Search
- Analyze
- Review
- Observe
- Generate

Capabilities expose behavior.

Capabilities are stable from the Builder perspective.

Capabilities may be implemented many ways.

## Resource

A Resource represents state.

Examples:

- Workspace
- Build
- TestRun
- Evaluation
- Deployment
- Artifact
- Environment
- Release
- Incident
- AgentTask

A Resource has identity, lifecycle, state, relationships, permissions, history, and Events.

Resources do not own behavior.

Behavior belongs to Capabilities.

## Event

An Event is an immutable fact.

Examples:

- BuildStarted
- BuildCompleted
- TestRunFailed
- DeploymentSucceeded
- DeploymentRolledBack
- EvaluationFinished
- ArtifactCreated

Events record what happened.

Events are not commands.

Events may cause additional work, but they do not request it themselves.

## Policy

A Policy is a rule evaluated by Forge.

Examples:

- Production deployments require approval.
- Agents cannot deploy directly to production.
- Evaluations must pass before rollout.
- High-risk changes require security review.
- Certain models cannot access sensitive Resources.

Policies govern behavior.

Policies are not Resources by default.

## Permission

A Permission is an authorization relationship.

Permissions answer:

> Which Builder may use which Capability or access which Resource?

Examples:

- Builder may invoke Deploy.
- Agent may read Artifact.
- Builder may approve Deployment.
- Service may create Evaluation.

Permissions authorize.

Policies govern.

## What Is Not in the Domain Model

The following are not domain concepts:

- Implementation
- Plugin
- API
- CLI
- UI
- SDK
- Workflow engine
- Scheduler
- Queue
- Controller
- Runtime
- Provider

These are architecture or implementation concepts.

## Composition

A Workflow is not a first-class domain concept.

A Workflow is an ordered composition of Capabilities in service of a Goal.

Example:

```text
Goal: Safely release version 142

Plan
  → Build
  → Test
  → Evaluate
  → Deploy
  → Observe
```

The composition matters.

But the irreducible domain concepts remain Goal, Capability, Resource, Event, Policy, Permission, and Builder.

## In One Sentence

Forge models software creation as Builders pursuing Goals through Capabilities that create and evolve Resources, emit Events, obey Policies, and respect Permissions.
