# Forge Platform Playbook

> The Playbook explains how Builders use Forge.

Forge usage follows the Domain Model.

Builders pursue Goals.

Goals require Capabilities.

Capabilities create and modify Resources.

Resources emit Events.

Policies govern.

Permissions authorize.

## The Builder Loop

```text
Goal
  → Capability
  → Resource
  → Event
  → Learning
  → Next Goal
```

This loop is the daily rhythm of Forge.

## Example 1 — Build a Feature

A Builder states a Goal:

> Add support for 8K video uploads.

Forge helps identify required Capabilities:

- Plan
- Search
- Generate
- Build
- Test
- Evaluate
- Deploy
- Observe

Capabilities create Resources:

- Workspace
- Build
- TestRun
- Evaluation
- Artifact
- Deployment

Resources emit Events:

- BuildCompleted
- TestRunFailed
- EvaluationPassed
- DeploymentSucceeded

The Builder owns the outcome.

Agents may perform much of the work.

## Example 2 — Investigate a Regression

Goal:

> Investigate the checkout latency regression.

Capabilities:

- Search
- Observe
- Analyze
- Review
- Generate

Resources:

- Incident
- TraceSet
- Analysis
- Patch
- Evaluation

Events:

- IncidentOpened
- AnalysisCompleted
- PatchProposed
- EvaluationPassed

Policy may require human approval before deployment.

Permissions determine which Builders and agents can access sensitive Resources.

## Example 3 — Safely Release

Goal:

> Safely release version 142 to production.

Capabilities:

- Build
- Test
- Evaluate
- Deploy
- Observe

Resources:

- Release
- Build
- TestRun
- Evaluation
- Deployment

Events:

- ReleaseCreated
- DeploymentStarted
- DeploymentProgressed
- DeploymentSucceeded
- DeploymentRolledBack

Forge coordinates the process.

The Builder decides.

## Humans and Agents

Humans and agents are both Builders.

They differ in judgment, context, and authority.

They should not differ in platform access patterns.

A human may click.

An agent may call an API.

Both should operate on the same Capabilities and Resources.

## Good Goal Statements

Good Goals describe outcomes.

Examples:

- Reduce signup latency below 300ms.
- Make this service safe to deploy.
- Add usage analytics to the dashboard.
- Investigate why the latest release increased errors.

Poor Goals describe mechanisms too early.

Examples:

- Run Bazel.
- Call Kubernetes.
- Use model X.
- Edit file Y.

Mechanisms may be necessary later.

They should not replace the Goal.

## Working with Capabilities

Capabilities are the verbs of Forge.

Use them directly when the next step is known.

Examples:

- Build this branch.
- Run tests.
- Evaluate this change.
- Deploy this release.
- Search related incidents.

Use Goals when the desired outcome is broader than a single step.

## Working with Resources

Resources are the state of Forge.

Builders inspect Resources to understand progress.

Examples:

- Is the Build complete?
- Did the Evaluation pass?
- What Artifact was produced?
- What Deployment is active?
- Which Events occurred?

## Working with Events

Events explain history.

Use Events to answer:

- What changed?
- When did it change?
- Who or what caused it?
- What happened next?

Agents use Events to maintain awareness.

Humans use Events to maintain trust.

## Working with Policies and Permissions

Policies explain what is allowed.

Permissions explain who may act.

When Forge blocks a Builder or agent, it should explain both.

A good block says:

- what was blocked
- which Policy applied
- which Permission was missing
- what can happen next

## Daily Rhythm

Start with Goals.

Let agents propose Capability sequences.

Review Resource state.

Watch Events.

Apply judgment.

Ship safely.

Learn from production.

Set the next Goal.

## The Forge Way

Builders pursue Goals.

Capabilities do work.

Resources show state.

Events tell the truth.

Policies keep work safe.

Permissions protect the system.

Agents multiply Builders.

Forge makes the whole system coherent.
