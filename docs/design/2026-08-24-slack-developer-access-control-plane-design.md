# Slack-Driven Developer Access & Quota Management Platform

**Status:** Design proposal
**Audience:** Software engineers and coding agents implementing the system
**Primary implementation language:** TypeScript / Node.js
**Primary interaction surface:** Slack
**Base OSS:** `duolingo/slack-ai-agent`
**Date:** 2026-08-23

---

## 1. Executive Summary

This project will fork and extend [`duolingo/slack-ai-agent`](https://github.com/duolingo/slack-ai-agent) into an internal Slack-driven developer self-service platform for developer account, entitlement, quota, and access request handling.

The platform will support natural-language Slack requests such as:

- "What's my current Claude and Codex quota?"
- "Give me Codex access for general developer SCIM group."
- "Give me Claude access for general developer SCIM group."
- "Increase my Codex quota for this month."
- "Increase my Claude quota for this month."
- "Invite my GitHub account to the `foo` org."
- "Add me to the GitHub `foo-infra` team."
- "Who in my team does not have Codex access?"
- "Why doesn't Tanaka have access to repository X?"
- "Give everyone in the Platform team the standard developer toolset."
- "Revoke developer tooling for people who moved out of Engineering or company."
- "Approve the installation of the new GitHub App for repository Y."

The LLM is responsible for conversational interpretation and user experience only. It must **not** be the authority for identity, authorization, entitlement state, approval policy, or provider-side writes.

The authoritative system responsibilities are:

| Responsibility                                      | Source of truth / actuator                            |
| --------------------------------------------------- | ----------------------------------------------------- |
| Employee identity and organization metadata         | YESOD                                                 |
| Slack user → employee mapping                       | YESOD                                                 |
| GitHub username ↔ company identity mapping         | YESOD                                                 |
| Department / team membership                        | YESOD                                                 |
| Claude / Codex seat and quota-role assignments      | Entra ID groups                                       |
| Claude / Codex provisioning                         | Entra ID → SCIM                                       |
| GitHub enterprise authentication                    | Entra ID SSO                                          |
| GitHub team/repository permissions                  | GitHub APIs and/or managed enterprise mechanisms      |
| Linear provisioning / entitlement where IdP-managed | Entra ID / SCIM                                       |
| Request and approval state                          | This platform                                         |
| Policy decisions                                    | This platform, deterministic                          |
| Audit log                                           | This platform                                         |
| Actual downstream state                             | Provider APIs                                         |
| OpenAI API Platform infrastructure                  | Official OpenAI Terraform provider, where appropriate |

The platform should therefore be treated as an **AI-native developer access control plane with Slack as its front end**, rather than as an autonomous Slack agent with powerful administrative tools.

---

## 2. Goals

### 2.1 Primary goals

1. Provide a low-friction Slack interface for developer access and quota requests.
2. Centralize request handling across Claude, Codex, GitHub, Linear, and future developer services.
3. Reuse existing corporate identity and provisioning infrastructure rather than create a parallel IAM system.
4. Make entitlement decisions deterministic, auditable, testable, and policy-driven.
5. Support both self-service and approval-required requests.
6. Allow users and operators to inspect current entitlement state and request status.
7. Detect and surface drift between desired state and actual provider state.
8. Preserve the strongest parts of the upstream Slack AI Agent:
   - Slack routing and threaded UX
   - streaming responses
   - MCP integration
   - sandboxing
   - environment sanitization
   - user-aware tool filtering
   - custom action confirmation UX
   - telemetry
9. Structure the codebase so local coding agents can implement features independently behind stable interfaces.
10. Minimize LLM authority over security-sensitive operations.

### 2.2 Secondary goals

- Support bulk/team-level entitlement operations.
- Support future web/admin UI without coupling business logic to Slack.
- Support provider migrations and new providers through adapters.
- Support policy simulation and dry-run.
- Support reconciliation and compliance reporting.
- Keep upstream synchronization feasible where practical.

---

## 3. Non-Goals

The platform is **not**:

1. A new employee directory.
2. A replacement for YESOD.
3. A replacement for Entra ID.
4. A generic IAM or PAM product.
5. A provider credential vault.
6. A direct autonomous administrative agent.
7. A Terraform-only workflow for per-user high-churn access assignments.
8. A system that infers authorization from free-form LLM reasoning.
9. A system that joins identities by matching email strings across systems.
10. A system where every provider admin API is exposed directly as an MCP tool.

---

## 4. Key Architectural Principles

### 4.1 Separate interpretation from authority

The LLM may:

- classify intent,
- extract requested resources,
- ask clarifying questions,
- summarize policies,
- explain failures,
- present approval requests,
- invoke narrow typed application tools.

The LLM must not:

- decide whether a request is authorized,
- select an approver based on free-form reasoning,
- directly assign seats or quota roles,
- directly mutate Entra group membership,
- directly alter privileged GitHub access,
- bypass policy,
- infer identity using email similarity,
- execute provider admin APIs through generic MCP tools.

### 4.2 YESOD is authoritative for employee identity

All human subjects must resolve to a canonical YESOD employee/member identity.

A canonical subject should not be represented by email alone.

Preferred identifier:

```ts
type EmployeeId = string; // immutable YESOD member/employee ID
```

YESOD is responsible for:

- active/inactive employee status,
- canonical company identity,
- Slack ID,
- GitHub username,
- current department,
- current team membership,
- other organizational metadata required by policy.

### 4.3 Entra ID is authoritative for managed SaaS entitlement assignment

For Claude and Codex:

```text
Slack request
  -> policy
  -> approval if required
  -> Entra group membership change
  -> SCIM
  -> downstream effective entitlement
```

The platform must avoid direct Claude/OpenAI seat mutation when the same entitlement is already managed via Entra/SCIM.

### 4.4 Desired state and actual state are distinct

The platform should model:

```text
YESOD organizational truth
        |
        v
Entra / managed desired entitlement state
        |
        v
Provider actual state
```

A request may succeed at the desired-state layer before the downstream provider has converged.

The UI must distinguish:

- requested,
- approved,
- desired state applied,
- downstream provisioning pending,
- verified active,
- drifted,
- failed.

### 4.5 Terraform manages infrastructure; request workflows manage assignments

Use Terraform for relatively stable administrative structures such as:

- OpenAI API projects,
- service accounts,
- provider-level groups and roles,
- rate-limit definitions,
- organization-level configuration,
- GitHub organization/repository baseline configuration,
- shared policy infrastructure.

Avoid turning every Slack user entitlement request into:

```text
commit -> PR -> terraform plan -> merge -> apply
```

unless a specific entitlement is intentionally GitOps-managed.

Rule of thumb:

> Terraform manages the entitlement system.
> The request service manages entitlement assignments.

### 4.6 Provider writes are deterministic application operations

Read-only provider data may be exposed to the agent through narrow MCP tools.

Privileged writes should go through:

```text
LLM
  -> submit typed request
  -> RequestService
  -> PolicyEngine
  -> ApprovalService
  -> EntitlementService
  -> ProviderAdapter
```

not:

```text
LLM -> generic provider admin MCP tool
```

---

## 5. Upstream OSS Evaluation and Forking Strategy

### 5.1 Upstream components to retain

Retain with minimal changes where possible:

- `SlackHandler`
- `MessageProcessor`
- `ReactionManager`
- `FileHandler`
- `ChannelConfigManager`
- streaming Slack response logic
- Slack event routing
- thread/session UX
- OpenTelemetry instrumentation
- MCP configuration plumbing
- Claude sandbox configuration
- sanitized subprocess environment
- model request handling
- configurable system/channel instructions

### 5.2 Components to refactor

Refactor:

#### `UserUtils`

Current role:

- reads `data/employees.yaml`,
- resolves Slack user metadata,
- derives a coarse tool role.

Target:

```text
UserUtils
  -> IdentityService
      -> YesodDirectoryAdapter
```

The local `employees.yaml` must no longer be authoritative in production.

#### `CustomActionRegistry`

Retain Slack approval UI mechanics, but remove business authorization responsibility.

Target split:

```text
CustomActionRegistry
  -> SlackActionPresenter
  -> RequestService
  -> ApprovalService
```

#### Tool allowlist

Keep the existing allowlist for **agent runtime capability control**, but do not use its ordered role hierarchy as business entitlement policy.

#### Tracking

Keep bot telemetry, but separate it from the immutable business audit log and usage ledger.

### 5.3 Components to replace

Replace:

- `PersistentMap` for request/approval state → PostgreSQL
- production `employees.yaml` → YESOD-backed identity resolution
- `requiresApproval: boolean` → policy-generated approval requirements
- direct privileged custom action execution → deterministic request execution

---

## 6. High-Level Architecture

```text
+------------------------------+
| Slack                        |
+--------------+---------------+
               |
               v
+------------------------------+
| Slack Agent                  |
| forked slack-ai-agent        |
|                              |
| - conversation               |
| - intent extraction          |
| - typed tools                |
| - approval presentation      |
| - status display             |
+--------------+---------------+
               |
               v
+------------------------------+
| Application / Control Plane  |
|                              |
| - RequestService             |
| - PolicyEngine               |
| - ApprovalService            |
| - EntitlementService         |
| - ReconciliationService      |
| - AuditService               |
+---+------------+-------------+
    |            |
    | identity   | desired state
    v            v
+---------+   +------------------+
| YESOD   |   | Entra ID         |
|         |   |                  |
| people  |   | entitlement      |
| org     |   | group membership |
| GitHub  |   +---------+--------+
| mapping |             |
+---------+             +-------> Claude via SCIM
                                +-------> Codex via SCIM
                                +-------> Linear where managed

              +-----------------------+
              | Provider Adapters     |
              |                       |
              | - GitHub              |
              | - OpenAI/Admin        |
              | - Claude/Admin        |
              | - Linear              |
              +----------+------------+
                         |
                         v
                  Actual provider state

+------------------------------+
| PostgreSQL                   |
|                              |
| requests                     |
| approvals                    |
| operations                   |
| audit_events                 |
| reconciliation snapshots     |
+------------------------------+
```

---

## 7. Domain Model

### 7.1 Subject

```ts
interface Subject {
  employeeId: string;
  slackUserId?: string;
  companyEmail: string;
  githubUsername?: string;

  employmentStatus: "active" | "leave" | "inactive";
  employmentType?: string;

  department?: {
    id: string;
    name: string;
  };

  teams: Array<{
    id: string;
    name: string;
  }>;
}
```

Rules:

- `employeeId` is canonical.
- Email is an attribute, not a primary identity join key.
- GitHub account identity is resolved through YESOD.
- Inactive or unresolved subjects fail closed for privileged requests.

### 7.2 Provider

```ts
type Provider = "claude" | "codex" | "github" | "linear" | "openai-api";
```

### 7.3 Entitlement

```ts
type Entitlement =
  | {
      type: "product_access";
      provider: "claude" | "codex" | "github" | "linear";
      tier?: string;
    }
  | {
      type: "quota_role";
      provider: "claude" | "codex";
      role: string;
    }
  | {
      type: "github_org";
      organization: string;
      role?: string;
    }
  | {
      type: "github_team";
      organization: string;
      teamSlug: string;
      role?: string;
    }
  | {
      type: "github_repository";
      repository: string;
      permission: "read" | "triage" | "write" | "maintain" | "admin";
    }
  | {
      type: "linear_team";
      teamId: string;
      role?: string;
    };
```

### 7.4 Entitlement change

```ts
interface EntitlementChange {
  subject: Subject;
  entitlement: Entitlement;
  operation: "grant" | "revoke" | "change";
  previousValue?: unknown;
  requestedValue?: unknown;
  effectiveUntil?: Date;
}
```

### 7.5 Request

```ts
interface AccessRequest {
  id: string;

  requesterEmployeeId: string;
  targetEmployeeIds: string[];

  source: {
    type: "slack" | "api" | "admin";
    channelId?: string;
    threadTs?: string;
    messageTs?: string;
  };

  change: EntitlementChange;

  justification?: string;

  status: RequestStatus;

  policySnapshot: PolicyDecision;

  createdAt: Date;
  updatedAt: Date;
}
```

---

## 8. Request State Machine

Use an explicit state machine.

```ts
type RequestStatus =
  | "requested"
  | "validating"
  | "policy_evaluated"
  | "awaiting_approval"
  | "approved"
  | "denied"
  | "executing"
  | "desired_state_applied"
  | "provisioning_pending"
  | "succeeded"
  | "failed"
  | "drifted"
  | "cancelled"
  | "expired";
```

Expected transitions:

```text
requested
  -> validating
  -> policy_evaluated
       -> denied
       -> approved
       -> awaiting_approval
            -> approved
            -> denied
            -> expired
  -> executing
  -> desired_state_applied
       -> provisioning_pending
       -> succeeded
       -> failed

succeeded
  -> drifted

failed
  -> executing   // explicit retry
```

Invalid transitions must be rejected in code.

A state-transition function should be centralized and unit-tested.

---

## 9. Identity Resolution

### 9.1 YESOD adapter

Create:

```ts
interface EmployeeDirectory {
  getByEmployeeId(employeeId: string): Promise<Subject | null>;
  getBySlackUserId(slackUserId: string): Promise<Subject | null>;
  getByCompanyEmail(email: string): Promise<Subject | null>;
  getByGitHubUsername(username: string): Promise<Subject | null>;
  listTeamMembers(teamId: string): Promise<Subject[]>;
  listDepartmentMembers(departmentId: string): Promise<Subject[]>;
}
```

Implementation:

```text
YesodEmployeeDirectory
```

Use YESOD MCP/API depending on the available production integration surface.

### 9.2 Caching

Allow short-lived read-through caching for performance.

Suggested defaults:

- employee identity: 5 minutes
- department/team membership: 2 minutes
- negative lookup: 30 seconds

Security-sensitive execution must either:

1. refresh identity immediately before execution, or
2. enforce a sufficiently short cache TTL and verify a version/timestamp.

### 9.3 Fail-closed behavior

Deny privileged mutations when:

- Slack user cannot be mapped to a YESOD employee,
- target employee does not exist,
- target employee is inactive,
- required GitHub username mapping is absent,
- organizational metadata required by policy is unavailable.

Do not ask the LLM to guess missing mappings.

---

## 10. Entra ID Integration

### 10.1 Responsibilities

Entra is the desired-state actuator for:

- Claude seat assignment,
- Claude quota-role assignment,
- Codex Enterprise seat assignment,
- Codex quota-role assignment,
- other SCIM-managed product access.

### 10.2 Adapter

```ts
interface EntraEntitlementBackend {
  listManagedGroups(subject: Subject): Promise<ManagedGroupMembership[]>;

  addMember(
    subject: Subject,
    groupId: string,
    idempotencyKey: string,
  ): Promise<ExecutionResult>;

  removeMember(
    subject: Subject,
    groupId: string,
    idempotencyKey: string,
  ): Promise<ExecutionResult>;
}
```

### 10.3 Configuration

Entitlement-to-group mappings should be explicit configuration, e.g.:

```yaml
entitlements:
  codex:
    access:
      standard:
        entra_group_id: "..."
    quota_roles:
      standard:
        entra_group_id: "..."
      heavy:
        entra_group_id: "..."
      highest:
        entra_group_id: "..."

  claude:
    access:
      enterprise:
        entra_group_id: "..."
    quota_roles:
      standard:
        entra_group_id: "..."
      heavy:
        entra_group_id: "..."
```

Use IDs, not display names, as canonical configuration.

### 10.4 Mutual exclusion

Quota-role groups may be mutually exclusive.

Changing:

```text
codex-standard -> codex-heavy
```

must be implemented as a controlled transition, not independent unrelated writes.

Prefer:

1. validate target group,
2. add target group,
3. verify membership,
4. remove conflicting old group,
5. verify final desired state.

If provider semantics require remove-first behavior, encode that explicitly.

### 10.5 Idempotency

Repeated execution of the same approved request must not create inconsistent state.

All writes require an idempotency key based on the request ID.

---

## 11. GitHub Enterprise Integration

### 11.1 Identity

GitHub identity must be resolved via:

```text
Slack ID -> YESOD employee -> githubUsername
```

Never rely on matching GitHub primary email with company email.

This is required because GitHub Enterprise SSO will operate in an environment where company and personal emails may be mixed.

### 11.2 Responsibilities

The GitHub adapter may support:

- inspect enterprise/org membership,
- inspect team membership,
- inspect repository permissions,
- add/remove team membership when permitted,
- add/remove repository access when permitted,
- explain effective access,
- reconcile desired access.

### 11.3 Adapter

```ts
interface GitHubEntitlementBackend {
  getUserState(subject: Subject): Promise<GitHubUserState>;

  getEffectiveRepositoryPermission(
    subject: Subject,
    repository: string,
  ): Promise<RepositoryPermissionResult>;

  addTeamMember(
    subject: Subject,
    organization: string,
    teamSlug: string,
    idempotencyKey: string,
  ): Promise<ExecutionResult>;

  removeTeamMember(
    subject: Subject,
    organization: string,
    teamSlug: string,
    idempotencyKey: string,
  ): Promise<ExecutionResult>;
}
```

### 11.4 SSO constraints

Do not attempt to manage identity by rewriting GitHub email/profile data.

Entra SSO owns authentication policy.

The GitHub adapter owns only resource-level operations explicitly delegated to this platform.

Where GitHub team sync or IdP-managed groups are authoritative, the platform should update the upstream entitlement source rather than fight synchronized GitHub state.

---

## 12. Linear Integration

Linear should follow the same source-of-truth rules.

If access is SCIM-managed:

```text
request -> Entra -> SCIM -> Linear
```

If a Linear-specific API is required for product/team-level settings, isolate it behind:

```ts
interface LinearEntitlementBackend {
  getUserState(subject: Subject): Promise<LinearUserState>;

  apply(
    change: EntitlementChange,
    idempotencyKey: string,
  ): Promise<ExecutionResult>;
}
```

Team names supplied by users must resolve through canonical identifiers before execution.

---

## 13. OpenAI Terraform Provider

The official OpenAI Terraform provider should be used only where it is the correct desired-state mechanism.

Candidate responsibilities:

- OpenAI API Platform projects,
- service accounts,
- organization roles/groups,
- rate-limit configuration,
- stable project-level administration,
- infrastructure-oriented spend alerts and controls exposed by the provider.

Do not move existing Codex Enterprise seat/quota assignment out of Entra merely because Terraform support exists.

Keep separate concepts:

```text
OpenAI API Platform infrastructure
  -> Terraform

ChatGPT Enterprise / Codex user entitlement assignment
  -> Entra / SCIM
```

If future provider versions gain complete ChatGPT Enterprise/Codex workspace administration support, reconsider this boundary deliberately.

---

## 14. Policy Engine

### 14.1 Requirements

Policy must be:

- deterministic,
- version-controlled,
- unit-testable,
- independent of LLM output,
- based on canonical identities and resource IDs,
- able to return an explanation,
- able to express auto-approval and human approval.

### 14.2 Decision model

```ts
interface PolicyContext {
  requester: Subject;
  targets: Subject[];
  change: EntitlementChange;
  now: Date;
}

interface ApprovalRequirement {
  kind: "employee" | "manager" | "team" | "group" | "custom";
  identifier?: string;
  approvalsRequired: number;
}

interface PolicyDecision {
  effect: "allow" | "deny" | "require_approval";
  reason: string;
  approvalRequirements?: ApprovalRequirement[];
  policyVersion: string;
}
```

### 14.3 Example policies

Examples only; final values should be configured by company policy.

```text
Active engineer -> standard Codex access
  auto-approve

Active engineer -> higher Codex quota
  manager approval

Highest Codex quota
  AI Platform approval

Non-engineer -> Claude/Codex access
  manager or designated owner approval

GitHub ordinary team access
  team owner approval

Privileged GitHub team/repository admin
  Security + team owner approval

Inactive employee
  deny

Unknown employee
  deny
```

### 14.4 Policy implementation choice

Initial implementation should favor simple typed TypeScript policy code with exhaustive unit tests.

Introduce Cedar/OPA only if policy complexity materially justifies it.

Avoid premature policy-language infrastructure.

---

## 15. Approval Model

### 15.1 Replace `requiresApproval: boolean`

Do not retain the upstream boolean as the business model.

Approvals are generated by policy.

### 15.2 Approval record

```ts
interface Approval {
  id: string;
  requestId: string;

  requirementIndex: number;

  approverEmployeeId: string;
  decision: "approved" | "denied";

  reason?: string;
  decidedAt: Date;
}
```

### 15.3 Slack approval security

At button-click time:

1. resolve Slack approver through YESOD,
2. reload request,
3. ensure request is still pending,
4. evaluate whether the approver satisfies the approval requirement,
5. reject self-approval when policy forbids it,
6. record immutable approval event,
7. only transition once all requirements are satisfied.

Do not trust:

- Slack button metadata alone,
- the original requester identity,
- the LLM,
- cached free-form role labels.

### 15.4 Approval expiration

Default:

```text
7 days
```

Configurable by policy.

Expired approval requests must transition to `expired`.

---

## 16. Slack Agent Tool Surface

The LLM should receive a deliberately narrow set of application tools.

### 16.1 Read tools

Examples:

```text
get_my_entitlements
get_employee_entitlements
get_team_entitlement_summary
get_request_status
get_my_usage
explain_github_access
list_available_quota_roles
```

### 16.2 Write/request tools

Prefer one generic typed request tool:

```ts
submit_entitlement_request({
  target,
  entitlement,
  operation,
  requestedValue,
  effectiveUntil,
  justification,
});
```

or a small number of domain-specific tools if schemas become too broad.

### 16.3 Forbidden tool surface

Do not expose the following directly to the agent:

```text
entra_add_group_member
entra_remove_group_member
github_add_team_member
github_set_repository_permission
openai_assign_seat
claude_set_limit
linear_suspend_user
```

Those operations belong behind the control plane.

---

## 17. Slack UX

### 17.1 Request intake

Example:

```text
User:
Increase my Codex quota to heavy until the end of this month.

Bot:
You are currently on Codex standard quota.

Requested change:
  Standard -> Heavy
  Effective until: 2026-08-31

Policy:
  Manager approval required.

I created request DEVACC-1042 and asked your manager for approval.
```

### 17.2 Approval

```text
Request DEVACC-1042

Requester: Alice
Department: Engineering
Team: Platform
Change: Codex quota Standard -> Heavy
Expires: 2026-08-31
Reason: Release stabilization

[Approve] [Deny]
```

### 17.3 Provisioning state

After approval:

```text
Approved.

Entra desired state has been updated.
Waiting for SCIM propagation to Codex.
```

After reconciliation:

```text
Completed.

Codex now reports the Heavy quota role for Alice.
```

### 17.4 Explainability

For denials:

```text
This request was denied by policy because the target user is not an active employee.
```

The LLM may rephrase deterministic policy output, but must not invent the reason.

---

## 18. PostgreSQL Data Model

Suggested initial schema.

### 18.1 `requests`

```sql
id uuid primary key
request_number bigint unique
requester_employee_id text not null
source_type text not null
slack_channel_id text
slack_thread_ts text
slack_message_ts text
provider text not null
operation text not null
entitlement_type text not null
entitlement_payload jsonb not null
justification text
status text not null
policy_version text not null
policy_snapshot jsonb not null
created_at timestamptz not null
updated_at timestamptz not null
```

### 18.2 `request_targets`

```sql
request_id uuid not null
employee_id text not null
primary key (request_id, employee_id)
```

### 18.3 `approvals`

```sql
id uuid primary key
request_id uuid not null
requirement_index integer not null
approver_employee_id text not null
decision text not null
reason text
decided_at timestamptz not null
unique (request_id, requirement_index, approver_employee_id)
```

### 18.4 `provider_operations`

```sql
id uuid primary key
request_id uuid not null
provider text not null
operation text not null
idempotency_key text not null unique
input jsonb not null
result jsonb
status text not null
attempt integer not null
started_at timestamptz
completed_at timestamptz
error_code text
error_message text
```

### 18.5 `audit_events`

Append-only.

```sql
id uuid primary key
request_id uuid
event_type text not null
actor_employee_id text
actor_system text
payload jsonb not null
created_at timestamptz not null
```

Do not update or delete audit events in normal application logic.

### 18.6 `reconciliation_snapshots`

```sql
id uuid primary key
employee_id text not null
provider text not null
desired_state jsonb
actual_state jsonb
status text not null
checked_at timestamptz not null
```

---

## 19. Audit Requirements

Record at minimum:

- original requester,
- target users,
- canonical employee IDs,
- original Slack request link,
- parsed requested operation,
- policy input summary,
- policy version,
- policy decision,
- required approvals,
- approval actors,
- execution operations,
- idempotency key,
- provider response summary,
- desired-state verification,
- downstream-state verification,
- failures/retries,
- manual overrides.

Never put provider secrets or access tokens into audit payloads.

---

## 20. Security Model

### 20.1 Credential isolation

Provider admin credentials must be available only to deterministic adapters.

The Claude/Codex agent subprocess must not inherit them.

Retain the upstream sanitized environment mechanism and expand its tests.

### 20.2 Least privilege

Create dedicated service principals / GitHub Apps / provider admin credentials with minimum scopes.

Avoid long-lived personal tokens.

### 20.3 Identity fail-closed

Unknown or ambiguous user identity:

```text
deny mutation
```

not:

```text
guess
```

### 20.4 Approval TOCTOU

Immediately before execution:

1. reload target identity from YESOD,
2. revalidate active status,
3. verify request has enough valid approvals,
4. optionally re-run policy if relevant organizational state changed,
5. acquire request execution lock,
6. execute.

### 20.5 Concurrency

Use database transactions / row locking to prevent:

- duplicate approvals,
- double execution,
- concurrent incompatible quota-role changes,
- repeated Slack button clicks.

### 20.6 Prompt injection

Treat Slack text and provider content as untrusted.

No retrieved text can override:

- tool permissions,
- policy,
- approval requirements,
- provider adapter routing.

### 20.7 "YOLO" bypass

The upstream custom-action "YOLO emoji" bypass must not be enabled for entitlement mutations.

Remove or hard-disable it for all governance actions.

---

## 21. Reconciliation

### 21.1 Purpose

Requests change desired state, but SCIM and provider systems may converge asynchronously.

A reconciliation worker must compare desired and actual state.

### 21.2 Example

```text
Entra:
  Alice ∈ codex-heavy

Codex:
  Alice reports standard

=> provisioning_pending
```

After timeout:

```text
=> drifted
```

### 21.3 Scheduling

Initial recommendation:

- recently changed requests: reconcile every 1–5 minutes
- stable users: periodic batch reconciliation
- manual `/access reconcile` or equivalent for operators

Do not run high-frequency provider-wide polling unless required.

### 21.4 Drift handling

Drift should:

- create an audit event,
- update request state when relevant,
- surface an operator-visible alert,
- not silently mutate unrelated state.

Automatic remediation may be added per entitlement if safe.

---

## 22. Usage and Quota Data

Keep bot model telemetry separate from product quota state.

Define:

```ts
interface UsageSnapshot {
  employeeId: string;
  provider: Provider;
  product: string;
  meter: string;
  quantity: number;
  unit: string;
  cost?: {
    amount: number;
    currency: string;
  };
  periodStart: Date;
  periodEnd: Date;
  fetchedAt: Date;
}
```

Provider APIs are authoritative for quota usage.

The Slack bot's own token/cost telemetry must not be treated as Claude/Codex enterprise quota usage.

---

## 23. Application Module Layout

Suggested target structure:

```text
src/
  slack/
    slack-handler.ts
    message-processor.ts
    approval-presenter.ts
    request-presenter.ts

  agent/
    agent-runtime.ts
    tools/
      read-tools.ts
      request-tools.ts
    prompts/

  identity/
    employee-directory.ts
    yesod-client.ts
    yesod-employee-directory.ts
    identity-cache.ts

  governance/
    request-service.ts
    request-state-machine.ts
    policy-engine.ts
    approval-service.ts
    entitlement-service.ts
    audit-service.ts
    reconciliation-service.ts

  entitlements/
    types.ts
    catalog.ts
    config.ts

  providers/
    entra/
      client.ts
      adapter.ts
    github/
      client.ts
      adapter.ts
    linear/
      client.ts
      adapter.ts
    openai/
      client.ts
      adapter.ts
    claude/
      client.ts
      adapter.ts

  db/
    client.ts
    repositories/
      request-repository.ts
      approval-repository.ts
      operation-repository.ts
      audit-repository.ts
    migrations/

  telemetry/
    tracing.ts
    metrics.ts

  config/
    schema.ts
    loader.ts
```

Avoid provider-specific logic in Slack handlers.

---

## 24. Core Interfaces

### 24.1 Provider adapter

```ts
interface ProviderAdapter {
  readonly provider: Provider;

  getActualState(subject: Subject, entitlement: Entitlement): Promise<unknown>;

  execute(
    change: EntitlementChange,
    context: {
      requestId: string;
      idempotencyKey: string;
    },
  ): Promise<ExecutionResult>;
}
```

### 24.2 Entitlement backend

Some entitlements map to Entra rather than directly to the named product.

```ts
interface EntitlementBackend {
  supports(entitlement: Entitlement): boolean;

  getDesiredState(subject: Subject, entitlement: Entitlement): Promise<unknown>;

  applyDesiredState(
    change: EntitlementChange,
    context: ExecutionContext,
  ): Promise<ExecutionResult>;
}
```

### 24.3 Request service

```ts
interface RequestService {
  create(input: CreateRequestInput): Promise<AccessRequest>;
  get(id: string): Promise<AccessRequest | null>;
  cancel(id: string, actor: Subject): Promise<AccessRequest>;
  executeApproved(id: string): Promise<AccessRequest>;
}
```

### 24.4 Approval service

```ts
interface ApprovalService {
  approve(
    requestId: string,
    approver: Subject,
    reason?: string,
  ): Promise<AccessRequest>;

  deny(
    requestId: string,
    approver: Subject,
    reason?: string,
  ): Promise<AccessRequest>;
}
```

---

## 25. Error Model

Use structured application errors.

```ts
type ErrorCode =
  | "IDENTITY_NOT_FOUND"
  | "IDENTITY_INACTIVE"
  | "GITHUB_MAPPING_MISSING"
  | "ENTITLEMENT_UNKNOWN"
  | "POLICY_DENIED"
  | "APPROVER_NOT_AUTHORIZED"
  | "REQUEST_STATE_INVALID"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_CONFLICT"
  | "PROVISIONING_TIMEOUT"
  | "DRIFT_DETECTED";
```

The LLM can present user-friendly text based on error code and safe details.

Do not pass raw provider errors directly into Slack when they may contain sensitive information.

---

## 26. Observability

### 26.1 Metrics

Track:

- requests created by provider/type,
- auto-approved vs human-approved,
- approval latency,
- execution latency,
- SCIM convergence latency,
- success/failure rate,
- reconciliation drift rate,
- provider API errors,
- policy denials,
- unresolved YESOD mappings,
- duplicate execution prevention events.

### 26.2 Tracing

Retain OpenTelemetry.

Create spans around:

```text
slack.request
identity.resolve
policy.evaluate
approval.record
entitlement.apply
provider.execute
reconciliation.check
```

Do not add sensitive employee attributes to unrestricted telemetry.

### 26.3 Logs

Use structured logs with:

- request ID,
- Slack message ID,
- provider,
- operation,
- canonical employee ID where permitted.

Avoid logging request text from private Slack contexts unless explicitly allowed under existing privacy policy.

---

## 27. Reliability

### 27.1 Idempotency

Every provider mutation must be retry-safe.

`request_id` should be the root idempotency scope.

### 27.2 Transaction boundaries

Recommended execution pattern:

```text
BEGIN
  lock request
  verify state == approved
  create provider_operation if absent
  mark executing
COMMIT

perform external API call

BEGIN
  persist result
  advance request state
  append audit event
COMMIT
```

Do not hold DB transactions open across network calls.

### 27.3 Retry

Retry only:

- network failures,
- explicit provider retryable errors,
- throttling,
- eventual-consistency reads.

Do not blindly retry:

- authorization failures,
- validation errors,
- policy denials,
- unknown identities.

Use bounded exponential backoff.

### 27.4 Background jobs

Initial implementation can use a PostgreSQL-backed job table or a small queue abstraction.

Avoid adding a heavyweight workflow engine until needed.

---

## 28. Configuration

Configuration should use schema validation, e.g. Zod.

Separate:

```text
static application config
entitlement catalog
policy config
secrets
```

Secrets must come from the deployment secret mechanism, not committed YAML.

Example entitlement catalog:

```yaml
providers:
  codex:
    quota_roles:
      standard:
        backend: entra
        group_id: "..."
      heavy:
        backend: entra
        group_id: "..."

  github:
    teams:
      foo-infra:
        organization: "company"
        team_slug: "foo-infra"
        backend: github
```

---

## 29. Testing Strategy

### 29.1 Unit tests

Required for:

- state transitions,
- policy decisions,
- approval authorization,
- entitlement mapping,
- identity mapping,
- GitHub username resolution behavior,
- mutual-exclusive quota role transitions,
- idempotency,
- error mapping.

### 29.2 Contract tests

Create adapter contract suites:

```text
EmployeeDirectory contract
EntitlementBackend contract
ProviderAdapter contract
```

Each real/fake implementation must pass the same behavioral tests.

### 29.3 Integration tests

Use fake provider HTTP servers for:

- YESOD,
- Microsoft Graph / Entra,
- GitHub,
- Linear,
- OpenAI/Claude admin APIs.

Test:

```text
Slack request
-> typed request
-> policy
-> approval
-> desired-state change
-> reconciliation
```

### 29.4 Security tests

Test explicitly:

- unauthorized Slack user clicking Approve,
- duplicate button click,
- stale approval,
- target becomes inactive before execution,
- prompt asks agent to call hidden admin API,
- missing GitHub mapping,
- personal email differs from company email,
- forged email in user input,
- concurrent quota-role changes,
- provider retries after partial failure.

### 29.5 E2E tests

Run in a non-production Slack workspace and non-production provider tenants/groups.

No E2E test should mutate production entitlements.

---

## 30. Migration from Upstream

### Phase 1: Fork hygiene

1. Fork repository.
2. Rename product-facing text.
3. Fix license metadata inconsistency.
4. Add `UPSTREAM.md`.
5. Preserve upstream remote.
6. Add CI.
7. Establish branch protection.
8. Add architecture decision records.

### Phase 2: Identity abstraction

1. Introduce `EmployeeDirectory`.
2. Wrap current `employees.yaml` as `YamlEmployeeDirectory`.
3. Add `YesodEmployeeDirectory`.
4. Switch production config to YESOD.
5. Remove business-policy dependence on upstream roles.

This phased approach reduces regression risk.

### Phase 3: Persistence

1. Add PostgreSQL.
2. Add migrations.
3. Implement repositories.
4. Move pending approval state out of `PersistentMap`.
5. Keep `PersistentMap` only for non-critical ephemeral state if needed.

### Phase 4: Governance core

Implement:

- state machine,
- policy engine,
- request service,
- approval service,
- audit service.

### Phase 5: Codex/Claude via Entra

Start with:

- query current managed role,
- request standard access,
- request quota-role change,
- approval,
- Graph group mutation,
- reconciliation.

This is the recommended first production feature.

### Phase 6: GitHub

Add:

- YESOD GitHub username resolution,
- current org/team/repository access queries,
- team membership requests,
- effective access explanations.

### Phase 7: Linear and additional services

Add once the core abstractions are stable.

---

## 31. Recommended First Vertical Slice

Implement one complete path before broadening provider coverage:

> "Increase my Codex quota from Standard to Heavy."

Flow:

```text
1. Slack message received.
2. Agent resolves intent.
3. Agent calls `submit_entitlement_request`.
4. RequestService resolves requester via YESOD.
5. Entitlement catalog resolves Codex Heavy -> Entra group ID.
6. Entra backend reads current memberships.
7. PolicyEngine determines approval requirement.
8. Request persisted.
9. Slack approval message posted.
10. Approver clicks Approve.
11. ApprovalService resolves approver through YESOD.
12. ApprovalService validates authority.
13. Request transitions to approved.
14. Execution reloads target from YESOD.
15. Entra backend applies target quota-role group.
16. Request transitions to desired_state_applied.
17. Reconciliation checks downstream Codex state.
18. Request transitions to succeeded.
19. Slack thread updated.
20. All steps create audit events.
```

Completion of this slice validates nearly every important architectural boundary.

---

## 32. Coding-Agent Work Packages

The implementation should be delegated as small independent packages.

### WP-01: Fork normalization

Scope:

- product naming,
- config cleanup,
- upstream documentation,
- license metadata correction,
- CI baseline.

Acceptance criteria:

- upstream tests pass,
- build succeeds,
- no functional behavior change.

### WP-02: Identity abstraction

Scope:

- define `EmployeeDirectory`,
- adapt current YAML implementation,
- refactor `UserUtils` callers.

Acceptance criteria:

- no production code directly reads `employees.yaml`,
- current tests pass through abstraction.

### WP-03: YESOD integration

Scope:

- YESOD client,
- Slack ID lookup,
- employee ID lookup,
- GitHub username lookup,
- department/team lookup,
- caching.

Acceptance criteria:

- typed normalized `Subject`,
- fail-closed behavior,
- adapter integration tests.

### WP-04: PostgreSQL persistence

Scope:

- migrations,
- request repository,
- approval repository,
- provider operation repository,
- audit repository.

Acceptance criteria:

- transactions tested,
- migrations reversible where practical,
- repositories integration-tested.

### WP-05: Request state machine

Scope:

- transition model,
- invalid transition protection,
- state transition audit events.

Acceptance criteria:

- exhaustive transition tests.

### WP-06: Policy engine

Scope:

- typed policy context,
- initial rule set,
- policy versioning,
- policy explanations.

Acceptance criteria:

- no LLM dependency,
- table-driven unit tests.

### WP-07: Approval service

Scope:

- approval requirements,
- approver authorization,
- Slack button integration,
- duplicate-click protection,
- expiry.

Acceptance criteria:

- unauthorized approver cannot execute request,
- concurrent approval tests pass.

### WP-08: Entra backend

Scope:

- managed group reads,
- add/remove group membership,
- quota-role transitions,
- idempotency.

Acceptance criteria:

- fake Graph integration tests,
- mutual exclusion handled,
- retry model documented.

### WP-09: Entitlement catalog

Scope:

- typed entitlement config,
- provider/backend mapping,
- Zod validation,
- stable IDs.

Acceptance criteria:

- startup fails fast on invalid config.

### WP-10: Agent request tools

Scope:

- `get_my_entitlements`,
- `submit_entitlement_request`,
- `get_request_status`.

Acceptance criteria:

- no direct provider write tool exposed,
- schemas fully typed,
- safe error mapping.

### WP-11: Slack request/approval UX

Scope:

- request summary blocks,
- approval blocks,
- status updates,
- error/denial messages.

Acceptance criteria:

- all mutation UX references request ID,
- confirmation state survives process restart.

### WP-12: Codex quota vertical slice

Scope:

- Standard -> Heavy request,
- policy,
- approval,
- Entra mutation,
- reconciliation stub/real adapter.

Acceptance criteria:

- complete happy path,
- duplicate-safe,
- audit-complete.

### WP-13: Reconciliation worker

Scope:

- desired-vs-actual checks,
- provisioning pending,
- drift,
- retry scheduling.

Acceptance criteria:

- eventual convergence test,
- timeout/drift test.

### WP-14: GitHub adapter

Scope:

- YESOD username mapping,
- access queries,
- team membership changes,
- effective permission explanation.

Acceptance criteria:

- no email-based identity joining,
- GitHub mapping absence fails closed.

### WP-15: Security hardening

Scope:

- disable YOLO bypass for governance,
- secret isolation,
- admin tool deny tests,
- approval TOCTOU,
- logging privacy review.

Acceptance criteria:

- security test suite passes,
- provider credentials unavailable in agent subprocess.

---

## 33. Definition of Done for Each Work Package

Every coding-agent task should include:

1. code,
2. tests,
3. relevant migration/config updates,
4. documentation for public interfaces,
5. no unrelated refactoring,
6. upstream behavior preserved unless explicitly changed,
7. `npm test`,
8. `npm run build`,
9. lint/typecheck if configured,
10. explicit notes on security-sensitive assumptions.

Agents should not merge architecture changes implicitly.

If a task requires changing a stable interface from this design, it should produce an ADR or implementation note before proceeding.

---

## 34. Suggested ADRs

Create:

```text
docs/adr/
  0001-yesod-as-canonical-employee-directory.md
  0002-entra-as-managed-entitlement-backend.md
  0003-postgresql-for-governance-state.md
  0004-llm-not-authoritative-for-access-policy.md
  0005-no-email-based-github-identity-join.md
  0006-provider-writes-not-exposed-as-generic-mcp-tools.md
  0007-terraform-for-infrastructure-not-high-churn-assignments.md
```

---

## 35. API Boundary for Future Web/Admin UI

Business services must not depend on Slack-specific types.

For example:

```ts
createRequest(
  actor: Subject,
  input: CreateRequestInput,
): Promise<AccessRequest>
```

not:

```ts
createRequest(slackBody: SlackActionBody)
```

Slack conversion belongs in the presentation adapter.

This enables future:

- web admin console,
- REST API,
- CLI,
- scheduled automation,
- compliance exports.

---

## 36. Performance Expectations

This is not a latency-critical trading system, but Slack UX should remain responsive.

Targets:

- Slack acknowledgement: < 3 seconds
- identity lookup cached: < 100 ms typical
- request creation: < 1 second excluding LLM parsing
- read-only entitlement query: < 2 seconds typical
- approval button acknowledgement: immediate, execution async from Slack UX perspective
- provider convergence: provider-dependent and surfaced explicitly

Avoid blocking Slack event acknowledgement on long provider operations.

---

## 37. Operational Model

Recommended deployment characteristics:

- stateless application instances,
- PostgreSQL shared state,
- provider credentials via secret manager/runtime identity,
- horizontally scalable Slack handler,
- one or more background workers,
- leader-independent request execution using DB locks/idempotency,
- OpenTelemetry export,
- separate production and staging provider configuration.

Socket Mode may remain initially, but the application must not rely on single-process memory for correctness.

---

## 38. Open Questions

These require company-specific decisions before some work packages are implemented:

1. Exact Entra group IDs and quota-role semantics for Claude/Codex.
2. Whether quota roles are mutually exclusive and what transition order is required.
3. YESOD API/MCP authentication and production rate limits.
4. Exact source of manager relationship if manager approval is needed.
5. GitHub access categories that are IdP-managed vs GitHub-API-managed.
6. Linear access categories that are Entra/SCIM-managed vs provider-managed.
7. Which requests can auto-approve.
8. Which requests require dual approval.
9. Whether temporary entitlements should be implemented and how expiration is enforced.
10. Provider-side APIs available for verifying final Claude/Codex effective role.
11. Required retention duration for audit events.
12. Whether PostgreSQL should reuse an existing company database platform.
13. Whether a web admin UI is in initial scope.
14. Whether bulk requests should be transactional all-or-nothing or per-user best effort.

None of these questions invalidate the architecture above.

---

## 39. Explicit Invariants

These should be encoded in tests where possible.

1. No privileged provider mutation occurs without a persisted request.
2. No policy decision is produced by the LLM.
3. No approval is trusted without resolving the approver via YESOD.
4. No GitHub user is identified by matching arbitrary email strings.
5. No Claude/Codex seat or quota role bypasses Entra when that entitlement is Entra-managed.
6. No governance request state depends on process-local memory.
7. No provider admin secret is exposed to the agent subprocess.
8. No request executes twice because of duplicate Slack interactions.
9. No inactive employee receives a new privileged entitlement.
10. No generic MCP provider-admin write tool is available to the LLM.
11. Every mutation is auditable.
12. Every provider write is idempotent or guarded against duplicate execution.
13. Slack is a presentation surface, not a system of record.
14. YESOD is the canonical employee identity source.
15. Entra is the canonical assignment source for SCIM-managed entitlements.

---

## 40. Final Recommendation

Fork `duolingo/slack-ai-agent`.

Use it as:

- Slack event infrastructure,
- conversational interface,
- agent runtime,
- read-oriented MCP host,
- approval presentation layer.

Do **not** use it as the governance database or authorization engine.

Build a deterministic control-plane layer around:

```text
YESOD
  = identity and org truth

Entra ID
  = managed entitlement desired state

Provider APIs
  = actual downstream state

PostgreSQL
  = request / approval / audit state

PolicyEngine
  = authorization authority

Slack Agent
  = natural-language interface
```

The recommended implementation sequence is:

```text
Fork hygiene
-> identity abstraction
-> YESOD
-> PostgreSQL
-> state machine
-> policy
-> approval
-> Entra backend
-> entitlement catalog
-> Slack tools
-> Codex quota vertical slice
-> reconciliation
-> GitHub
-> Linear / additional providers
```

The first production milestone should be a complete, auditable Codex quota-role request flow via YESOD + policy + Slack approval + Entra + downstream reconciliation.

That vertical slice establishes the architecture needed for every subsequent provider.
