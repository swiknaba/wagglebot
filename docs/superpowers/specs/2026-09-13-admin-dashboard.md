# Admin Dashboard

## Scope

- Build a simple developer UI for a small engineering team.
- Include service status, task controls, usage statistics, and database metrics.
- Exclude knowledge content, message bodies, task instructions, and task results from the UI and admin API.
- Use simple tables, forms, and buttons.
- Omit application authentication, roles, and action history.
- Require external network protection for the dashboard and admin API.
- Treat network and reverse proxy setup as outside this project.
- Keep application authentication outside the MVP.
- Apply team and organization scopes in the API, not only in the browser.
- Use system and branch filters within the selected scope.
- Preserve the existing authentication for agent interfaces.
- Omit SQL consoles, container controls, alerts, and cloud provider integrations.

Dependencies:

| Requirement | Spec |
|---|---|
| Shared database and required Sequel tooling | [Phase 2](2026-08-28-phase-2-shared-layer.md#shared-database-and-migrations) |
| Presence, messages, and tasks | [Phase 3](2026-08-28-phase-3-collaboration.md) |
| Task fields and claim rules | [Contract C4](2026-08-28-service-contracts.md#c4-task-envelope-and-delegated-job-vocabulary-phase-3) |

The dashboard adds new interfaces. Phase 4 ingestion is not required.

## Components

| Component | Requirement |
|---|---|
| Package | `packages/dashboard` |
| Frontend | React, TypeScript, and Vite |
| Admin server | TypeScript/Bun |
| Deployment | One dashboard container, separate from the services it monitors |
| Browser access | Frontend and API under one origin |
| Database access | Read-only queries from the admin server |

- Keep service addresses and database credentials on the server.
- Expose internal admin routes through the private deployment network.
- Require the operator to configure that network outside this project.
- Use the same service functions for admin actions and agent actions.
- Keep task rules in the coordination service.
- Do not edit coordination tables or SQLite files from the dashboard.
- Keep the dashboard available when a service fails.
- Run migrations through the Phase 2 commands, outside the UI.

## Views

| View | Content |
|---|---|
| Overview | Service status, agent count, task counts, oldest queued task, stalled leases, database status |
| Agents | Agent, engineer, system, branch, last heartbeat, presence status |
| Tasks | ID, state, priority, owner, attempts, claim version, lease expiry, timestamps, and error code |
| Message bus | Channels, message counts, recent message rate, and last activity time |
| Usage | Activity by engineer and team, plus knowledge counts by scope and status |
| Database | Connection status, versions, migration status, application storage, available activity metrics |

- Add system, branch, agent, and task-state filters where applicable.
- Link tasks to their agent and team when their IDs are available.
- Show the last successful update.
- After a failed refresh, retain the previous result and mark it as outdated.
- Show separate states for empty results, unavailable services, and lost connections.

## Team, Organization, and Global Views

- Add a team or organization selector for service data.
- Add a Global option to the Overview.
- Resolve team IDs through catalog Group entries.
- Use catalog ownership to select the team's systems and domains.
- Apply the selected scope before API counts, pagination, and responses.
- Apply the same scope to update notices.
- Reject unknown team or scope values.
- Preserve existing service scope fields.
- Do not add a new stored `team` memory scope.

| Data | Scope rule |
|---|---|
| Team knowledge statistics | Counts for the selected team's systems and domains, with org-wide counts shown separately |
| Organization knowledge statistics | Counts for records with the `org` scope |
| Team collaboration | Agents, tasks, and channels selected through catalog ownership and service scope fields |
| Organization collaboration | Collaboration data across the organization |
| Global overview | Totals across all Wagglebot server data, including all teams and knowledge scopes |
| Service health and physical storage | Deployment totals, labeled separately from team data |

- Label each knowledge count with its scope.
- Keep team counts separate from org-wide counts.
- Preserve the API's scope rules when the dashboard requests data.
- Do not use these selectors as user authentication or access restrictions.

Global overview:

- Include all teams, systems, domains, branches, and stored knowledge scopes in the totals.
- Show active agents, tasks by state, active and inactive knowledge counts, recent message counts, and application storage.
- Count each knowledge record once, even when it has multiple scopes.
- Refresh totals every 30 seconds.
- Show the collection time.
- If a service fails, mark its totals unavailable or outdated.
- Keep unrelated database tables and other deployments outside these totals.
- Keep detailed views under their team and organization selectors.

## Usage Statistics

- Show active agents and last activity by engineer and team.
- Show task counts by state and message counts by engineer and team.
- Show knowledge counts by scope and status.
- Show active, inactive, and superseded knowledge counts without record details.
- Label the period covered by each activity count.
- Use stored metadata or service counters for these totals.
- Label counters that reset when a service restarts.
- Show unavailable attribution when the service has no engineer or team information.
- Do not infer attribution from stored content.
- Do not add activity history or individual knowledge views.

## Content Exclusion

- Select only the fields required for status, task controls, and statistics.
- Do not return complete stored records through admin endpoints.
- Exclude knowledge titles, text, tags, provenance details, and embedding values.
- Exclude message bodies and task payloads, results, and attachments.
- Return fixed error codes and operational descriptions.
- Do not forward raw service errors or logs.
- Apply these rules to HTTP responses and SSE notices.
- Keep knowledge editing, deletion, and content export outside this interface.

## API

Use `/api/admin` as the route prefix.

| Method and path | Result or action |
|---|---|
| `GET /overview` | Scoped summary and service status, including `scope=global` |
| `GET /agents` | Filtered agent list |
| `GET /tasks` | Filtered task list |
| `GET /tasks/:id` | Task status and control metadata |
| `POST /tasks/:id/expire-lease` | End the current claim |
| `POST /tasks/:id/cancel` | Cancel the task |
| `GET /channels` | Channels and recent message counts |
| `GET /usage` | Scoped activity and knowledge counts |
| `GET /database` | Database checks and metrics |
| `GET /events` | Server-Sent Events (SSE) update notices |

- Return 50 records per page by default.
- Limit each page to 200 records.
- Return a cursor for the next page.
- Use a fixed order with a unique ID as the final sort field.

## Live Updates

Phase 3 message events do not cover presence or task changes.

- Add update notices for agents, tasks, usage statistics, and service status.
- Send notices through one dashboard SSE connection.
- Name the data that changed in each notice.
- Do not store a second event history.
- Send `reset` when the browser connects.
- After `reset`, fetch current data for the visible views.
- Establish the SSE connection before the first data request.
- If a notice arrives during a request, repeat that request after it completes.
- Combine repeated notices before requesting the same data again.
- Reconnect automatically after a lost connection.
- Fetch current data after every reconnection.
- Preserve the message service's `Last-Event-ID` replay behavior for agent clients.
- Do not forward the agent message stream to the dashboard.
- Send periodic SSE messages to keep the connection open.
- Configure the reverse proxy to forward SSE messages without delay.
- Show a lost-connection indicator until the connection returns.

## Task Actions

Use `fence` as the claim version. Increase it for each new claim.
The service rejects updates from an older claim.

- Preserve the 90-second lease and 30-second heartbeat interval.
- Allow no more than three attempts.
- Use `idempotencyKey` to prevent duplicate external actions.
- Include the expected task state and `fence` in each admin action.
- Check these values and change the task in one database transaction.
- If either value changed, return `409 Conflict`.
- After a conflict, refresh the task and show the reason.
- Disable action buttons while a request is pending.
- Prevent repeated requests from changing the task twice.
- Use server time for lease decisions and displayed countdowns.

Lease expiration:

- Clear the current claim and lease in one transaction.
- Keep the current `fence` and attempt count.
- Return the task to the queue unless it has reached three failed attempts.
- After the third failed attempt, set the state to `failed`.
- Require an active, unexpired claim for each heartbeat and completion.
- Reject updates from an expired claim before another agent claims the task.

Cancellation:

- Cancel a queued task immediately.
- For a claimed task, store `cancelRequestedAt` and keep its state as `claimed`.
- Return `cancelRequestedAt` in task responses.
- Show pending cancellation in the UI.
- Reject completion after a cancellation request.
- Complete cancellation at the next heartbeat or lease expiry, whichever occurs first.
- Do not return a task with a cancellation request to the queue.

Neither action guarantees that the remote agent process stops immediately.

## Database View

Database setup and migrations are required by
[Phase 2](2026-08-28-phase-2-shared-layer.md#shared-database-and-migrations), even without the dashboard.

- Use the configured PostgreSQL database and application user.
- Support both the bundled container and remote PostgreSQL.
- Read the explicit application table list from the Phase 2 database tooling.
- Limit table metrics to that list.
- Do not infer table ownership from a prefix match alone.
- Do not enumerate other databases or unrelated tables.
- Keep SQL text and unrelated session details out of the UI.
- Keep credentials out of responses and errors.
- Collect metrics once every 30 seconds, regardless of browser count.
- Limit the connection pool size.
- Set a five-second timeout for metric queries.
- Keep slow metric queries separate from other views.

| Check | Display |
|---|---|
| Connection | Last successful check and query duration |
| Versions | PostgreSQL, pgvector, migration state, embedding metadata |
| Storage | Application table and index sizes, without duplicate totals |
| Records | Estimated rows per application table, labeled as estimates |
| Application activity | Pool use, query errors, query duration, when available |
| Database activity | Available connection, transaction, lock, and deadlock counts |

- Label database-wide metrics as shared totals.
- Show the migration version expected by the application and the version present in the database.
- Show unavailable metrics when the database user lacks access.
- Keep other metrics visible if one query fails.
- Do not require extra database roles.
- Omit host CPU, host memory, free disk space, and managed backup status.
- Do not store metric history.

## Service Failures and Storage

- Expose `/livez` on the admin server.
- Expose `/livez` and `/readyz` on the memory and coordination services.
- Set timeouts for service checks and database connection attempts.
- Report each service failure separately.
- Distinguish configuration errors from temporary connection failures.
- Close database and SSE connections during shutdown.
- Preserve the seven-day message retention period.
- Retain completed and cancelled tasks for seven days.
- Keep failed tasks for human inspection.
- Do not store duplicate messages or tasks for the dashboard.
- Preserve the coordination SQLite volume when PostgreSQL runs on a remote server.
- Use the Phase 2 dump and restore commands for database recovery.

## Acceptance Checks

- Verify database setup through the Phase 2 acceptance checks.
- Verify agent, task, and usage updates in the browser.
- Interrupt SSE during an update.
- Verify current data after reconnection.
- Test lease expiration during renewal, completion, and a new claim.
- Verify rejection of requests with an old claim version.
- Verify that repeated action requests cause only one change.
- Verify cancellation when the agent sends no further heartbeat.
- Stop each service separately.
- Verify visible errors and recovery after restart.
- Verify partial metrics with a restricted database user.
- Verify page and browser limits with larger datasets.
- Verify that team statistics exclude unrelated teams.
- Verify that org-wide knowledge counts remain separate from team counts.
- Verify that scoped counts, pages, and update notices use the same selection.
- Verify active, inactive, and superseded knowledge counts.
- Add test content to knowledge records, messages, task payloads, results, and service errors.
- Verify that this content never appears in admin HTTP responses, SSE notices, or rendered views.
- Verify that the admin API has no knowledge or message content endpoint.
- Verify Global totals across multiple teams and knowledge scopes.
- Verify that a record with multiple scopes contributes only once to the Global total.
- Verify that Global totals exclude unrelated database objects.
