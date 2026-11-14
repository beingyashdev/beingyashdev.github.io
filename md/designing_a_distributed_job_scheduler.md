# Designing a Distributed Job Scheduler: From a Polling Loop to a Fault-Tolerant System

*An engineering journey through scheduling semantics, concurrency, crash recovery, idempotency, leader election, Kafka, and the tradeoffs that actually justify complexity.*

> **The design principle:** Start with the smallest system that satisfies the requirements. Introduce distributed coordination only when a concrete failure mode or scaling constraint demands it.

A job scheduler sounds deceptively simple: store a task, record when it should run, and execute it at the right time. The complexity appears when the system must survive machine crashes, run on multiple nodes, process bursts of work, and interact with services that cannot safely be called twice.

This article builds a scheduler from first principles. Rather than assuming that Kafka, leader election, or distributed locks are mandatory, we will ask what each component buys us—and what new problems it introduces.

## 1. Start with the contract, not the architecture

Imagine an API that accepts a reminder to be sent at 10:00 AM:

```json
{
  "job_type": "SEND_REMINDER",
  "payload": {"reminder_id": "r-42"},
  "scheduled_at": "2026-11-16T10:00:00Z"
}
```

A basic jobs table might contain:

| job_id | scheduled_at | status | job_type |
|---|---|---|---|
| 101 | 10:00:00 | PENDING | SEND_REMINDER |
| 102 | 10:00:05 | PENDING | SEND_REMINDER |

Before choosing technology, define the semantics:

- **Eligibility:** A job is due when `scheduled_at <= now` and its state permits execution.
- **Start time:** The timestamp is normally an *earliest eligible time*, not a promise that CPU execution begins at the exact millisecond.
- **Delivery guarantee:** Do we require best effort, at-least-once attempts, or a business effect that happens at most once?
- **Recovery:** What should happen after a crash during execution?
- **Ordering:** Must jobs run strictly in scheduled-time order, or is approximate fairness sufficient?
- **Recurrence:** Is each row a one-time execution, or a definition of a recurring schedule?

These choices determine the architecture far more than a preferred framework does.

### Scheduling latency is not execution duration

A useful distinction is:

```text
scheduled_at  ->  discovered_at  ->  claimed_at  ->  started_at  ->  completed_at
               discovery delay     claim delay     queue delay     run duration
```

Define **job-start latency** as `started_at - scheduled_at`. A job scheduled for 10:00:00 that starts at 10:00:03 has three seconds of start latency even if its actual work takes only 20 milliseconds.

Polling interval, database contention, worker capacity, and downstream throttling all affect this latency. A shorter polling interval alone does not guarantee punctual execution.

## 2. Do we even need a separate scheduler?

For an immediate task, often not. The application can hand work directly to an asynchronous executor or durable queue.

For a future task, something must recognize that its due time has arrived. But **scheduling logic is not synonymous with a dedicated scheduler service**.

A long-running worker can poll PostgreSQL:

```sql
SELECT id
FROM jobs
WHERE status = 'PENDING'
  AND scheduled_at <= clock_timestamp()
ORDER BY scheduled_at, id
LIMIT 20;
```

This is enough to *discover* eligible work. It is **not** enough to safely *claim* work when multiple workers run concurrently.

There is also no intrinsic need for a stored `READY` status. If readiness means `PENDING AND scheduled_at <= now`, it is a derived condition. A `READY` state is useful only if it represents a meaningful additional workflow transition, such as a scheduler handing work to a separate dispatcher.

Our first architecture can therefore be remarkably small:

```text
Client -> Job API -> PostgreSQL jobs table
                           ^
                           |
                  Worker A / B / C
                  poll -> claim -> execute
```

The worker is the **execution component**, not necessarily a Kafka consumer. It can pull jobs from a database, consume broker messages, or receive tasks through another transport.

## 3. Multiple workers introduce a concurrency problem

Suppose Worker A and Worker B both read job 101 as `PENDING`. If they separately decide to execute it, the job may run twice.

The mistake is a non-atomic check-then-act sequence:

```text
A reads PENDING      B reads PENDING
A starts execution   B starts execution
```

We need **atomic claiming**. PostgreSQL provides a practical approach using row locks and `SKIP LOCKED`:

```sql
BEGIN;

WITH eligible AS (
    SELECT id
    FROM jobs
    WHERE status = 'PENDING'
      AND scheduled_at <= now()
    ORDER BY scheduled_at, id
    LIMIT 20
    FOR UPDATE SKIP LOCKED
)
UPDATE jobs AS j
SET status = 'PROCESSING',
    claimed_by = :worker_id,
    attempt_count = j.attempt_count + 1
FROM eligible
WHERE j.id = eligible.id
RETURNING j.id, j.job_type, j.payload;

COMMIT;
```

The transaction claims a bounded batch, commits, and **only then** executes the business logic. We must not hold row locks across slow API calls.

`SKIP LOCKED` means another worker can skip rows currently locked by a competing transaction instead of waiting for them. This is **pessimistic locking**, not optimistic locking. It is especially useful for work queues, though it does not guarantee strict FIFO ordering under contention.

For a known job ID, a simpler conditional update can suffice:

```sql
UPDATE jobs
SET status = 'PROCESSING', claimed_by = :worker_id
WHERE id = :job_id AND status = 'PENDING'
RETURNING id;
```

Under PostgreSQL `READ COMMITTED`, competing updates on the same row serialize; the waiting update re-evaluates its predicate against the updated row. One claimant succeeds, the other returns no row. No extra advisory lock is required for this claim.

**Decision:** Use atomic database claims before introducing global leader election. Different workers can safely claim different jobs without a single coordinator.

## 4. A claimed job is not a locked job

After the claim transaction commits, PostgreSQL releases its row locks. The persistent `PROCESSING` status records a claim; it is **not** a database lock held for the entire execution.

Now consider:

```text
Worker A claims job 101 -> COMMIT
Worker A begins external call
Worker A crashes
Database still says PROCESSING
```

If every worker only searches for `PENDING`, job 101 remains stuck forever. We need a recovery policy.

### Option A: a reconciliation process

A periodic process finds jobs that appear abandoned and returns them to an eligible state. The challenge is deciding when an attempt is actually abandoned.

### Option B: per-job leases and heartbeats

Store an expiration timestamp and a claim generation:

```text
job_id=101
status=PROCESSING
claimed_by=worker-A
lease_until=10:00:30
claim_version=6
```

A healthy worker renews the lease periodically:

```sql
UPDATE jobs
SET lease_until = clock_timestamp() + interval '30 seconds'
WHERE id = :job_id
  AND status = 'PROCESSING'
  AND claimed_by = :worker_id
  AND claim_version = :my_version
  AND lease_until > clock_timestamp()
RETURNING id;
```

If renewal affects zero rows, the worker must treat ownership as lost. Renewal should run independently of potentially blocking business execution.

A different worker can atomically reclaim an expired attempt:

```sql
UPDATE jobs
SET claimed_by = :new_worker,
    lease_until = clock_timestamp() + interval '30 seconds',
    claim_version = claim_version + 1,
    attempt_count = attempt_count + 1
WHERE id = :job_id
  AND status = 'PROCESSING'
  AND lease_until < clock_timestamp()
RETURNING claim_version;
```

The new claim receives version 7. If Worker A later resumes, its completion update with version 6 fails:

```sql
UPDATE jobs
SET status = 'COMPLETED', lease_until = NULL
WHERE id = :job_id
  AND status = 'PROCESSING'
  AND claimed_by = :worker_id
  AND claim_version = :my_version;
```

The version is a **fencing mechanism for these database state changes**. It prevents an old owner from overwriting the new owner's status. It does *not* undo or block an external API call that the old owner already started.

### The unavoidable ambiguity

Lease expiration means the owner failed to renew on time. It does **not** prove the process crashed. A long pause or network partition can cause Worker B to reclaim the job while Worker A continues working.

This is why a lease solves **recovery and ownership**, not exactly-once business effects.

## 5. Idempotency is the real boundary of business correctness

Suppose job 101 charges a customer:

```text
A claims job
A calls payment gateway -> payment succeeds
A crashes before marking COMPLETED
B retries job
```

The database says `PROCESSING`, but the payment may already have happened. Retrying blindly could charge twice; skipping could leave an unexecuted payment unprocessed.

**A worker cannot infer an external system's outcome from local job status.** This is the ambiguous-outcome problem.

### When the external API supports idempotency

Use a stable key for the **logical job execution**, not a new key per worker attempt:

```text
idempotency_key = payment-job-101
```

If the gateway guarantees safe deduplication—including concurrent requests—and retains the key across the retry window, Workers A and B can both invoke the gateway with that same key without duplicating the payment. They may still receive `IN_PROGRESS`, timeouts, or other responses that require the gateway's documented retry procedure.

In that specific architecture, overlapping execution attempts may be acceptable. You might not need per-job leases solely to prevent duplicate gateway effects. You still need monotonic job-status transitions:

```sql
UPDATE jobs
SET status = 'PROCESSING'
WHERE id = :job_id AND status = 'READY';

UPDATE jobs
SET status = 'COMPLETED'
WHERE id = :job_id AND status IN ('READY', 'PROCESSING');
```

A late worker must never change `COMPLETED` back to `PROCESSING`. A zero-row `READY -> PROCESSING` update does not necessarily mean the worker should stop: `PROCESSING` can be retried if concurrent attempts are safe, while `COMPLETED` should be skipped.

### When the business effect is inside PostgreSQL

If the entire effect and the completion marker live in the same database, they can be committed atomically. For example, lock and validate the execution row, apply the business change, mark completion, and commit in one transaction. If the transaction aborts, neither change persists. This requires correct validation of ownership, business constraints, and affected row counts.

A unique operation key or `INSERT ... ON CONFLICT` can enforce deduplication of a business mutation. **Merely inserting a `PROCESSING` idempotency record is not proof that the operation completed.** A worker might crash immediately after the insert.

### When the external API does not support idempotency

No arrangement of local status updates and Kafka offset commits can generally guarantee both no missed external effect and no duplicate effect across crashes.

Options include a gateway-supported unique business reference, a reliable status lookup, settlement reconciliation, an `UNKNOWN` state requiring investigation, or explicitly accepting at-most-once attempts or duplicate risk. A status lookup alone can race unless the gateway provides sufficiently strong uniqueness and visibility guarantees.

**Decision:** Design the duplicate-effect strategy per business operation. Not every job needs a separate idempotency table, but every retryable job needs a defined answer to “what if this runs twice?”

## 6. Do we need a leader?

Not for workers independently claiming due rows. PostgreSQL already coordinates each claim.

A leader becomes useful when some responsibility must have a single active coordinator—for example, generating recurring job occurrences, maintaining a global schedule cursor, or performing singleton maintenance. Even there, a unique constraint and idempotent generation may be simpler than global leadership.

If we choose leader election, PostgreSQL offers two approaches.

### Session-level advisory lock

```sql
SELECT pg_try_advisory_lock(12345);
```

Only one PostgreSQL session holds the key at a time. Followers can retry `pg_try_advisory_lock()` with jitter, or block using `pg_advisory_lock()`. The leader holds the session open; the lock is released on explicit unlock or when PostgreSQL detects that the session ended.

A transaction-level advisory lock, `pg_try_advisory_xact_lock`, is released at transaction end and therefore does not maintain leadership across independent transactions.

Session locks require careful connection management: never return the lock-holding connection to a pool while assuming the application still owns it. A network failure can release the database lock while the former leader's application code continues to run.

### Expiring database lease

A shared row records `owner_id`, `lease_until`, and optionally a monotonically increasing fencing token. All contenders use an atomic conditional update; one wins, others do not. The leader renews periodically. A healthy leader can remain leader indefinitely.

A lease gives configurable timeout-based failover but does not forcibly stop a stale leader. Critical protected operations must validate ownership atomically or use downstream fencing.

**Important nuance:** PostgreSQL advisory locks are already provided by the database's coordination machinery. Calling this a “consensus problem” describes the high-level need to agree on leadership; the application does not need to implement Paxos or Raft just to coordinate through a trusted PostgreSQL primary.

## 7. Why introduce Kafka if PostgreSQL can already queue jobs?

It is tempting to jump straight to:

```text
Scheduler -> Kafka -> Workers
```

But Kafka is not inherently required for correctness or timing. A database-backed worker pool already provides durable jobs, horizontal execution, atomic claiming, and lease-based recovery.

Kafka becomes attractive when we need **durable asynchronous handoff, burst buffering, independent scaling of dispatch and execution, or integration with other services**. It also introduces partitions, offsets, consumer rebalances, retry policies, and additional operational cost.

Compare the paths:

```text
A. Database-backed
Job API -> PostgreSQL <- polling workers -> business effect

B. Queue-backed
Job API -> PostgreSQL -> outbox relay -> Kafka -> workers -> business effect
```

Kafka does not execute jobs faster by itself. If 100,000 jobs become due and workers can complete 500 per second, the backlog takes at least about 200 seconds to drain in an idealized no-new-arrivals model, regardless of whether it waits in PostgreSQL or Kafka.

### The dual-write problem

A scheduler cannot safely do these two independent operations without a failure gap:

```text
1. Mark job DISPATCHED in PostgreSQL
2. Publish event to Kafka
```

Crash after step 1, before step 2: the database claims dispatch happened, but Kafka never received the event.

Reversing the order creates a different ambiguity: Kafka may receive the event, but the database might not record dispatch.

### Transactional outbox

Write the job-state transition and an outbox event in **one PostgreSQL transaction**:

```sql
BEGIN;

UPDATE jobs
SET status = 'DISPATCH_PENDING'
WHERE id = :job_id AND status = 'PENDING';

-- Insert the event only if the preceding transition succeeded.
INSERT INTO outbox_events (event_id, job_id, event_type, payload)
VALUES (:event_id, :job_id, 'JOB_DUE', :payload);

COMMIT;
```

In real code, use the update's returned rows or a CTE so that an outbox event cannot be inserted when the job transition failed. The relay reads committed outbox rows and publishes them to Kafka.

The outbox guarantees **durable intent to publish**, not exactly-once delivery. A relay can publish successfully, crash before recording publication, and later publish the same event again.

Therefore, the consumer still needs deduplication or safe idempotent execution.

## 8. Kafka redelivery is not the same as safe job retry

Kafka consumers in a group normally have exclusive partition assignments, but this does not mean a business operation can execute only once.

Consider:

```text
Worker A reads partition P0, offset 100
A performs business effect
A crashes before committing offset 101
Partition is reassigned
Worker B reads offset 100 again
```

Kafka tracks committed offsets, not whether an external API succeeded. Rebalances can also allow a previous consumer's already-started business logic to overlap with a new consumer's processing.

A sound consumer workflow is:

```text
receive -> check durable completion -> execute safely
        -> persist confirmed completion -> commit offset
```

If a job is already `COMPLETED`, skip the external effect and acknowledge the record. If it is `PROCESSING`, the right action depends on the chosen contract:

- With strong concurrent gateway idempotency, retrying the same logical execution may be safe without an exclusive worker claim.
- Without that guarantee, overlapping attempts require coordination, and ambiguous outcomes may require reconciliation rather than automatic retry.

Never commit an offset merely because a job is `PROCESSING` unless another durable mechanism is responsible for eventual completion or recovery. Likewise, committing offsets before execution risks losing work on a crash.

Kafka also does not automatically implement business retry delays, retry limits, poison-message handling, or dead-letter policies. These are application decisions. Retry topics or a durable retry store can keep one repeatedly failing record from blocking its partition indefinitely.

## 9. Worker polling, thundering herd, and backpressure

Even a correct scheduler can collapse under load.

Suppose 100 workers poll PostgreSQL every second. If all start together, they may repeatedly query at the same instant. This is a **thundering herd**: synchronized contenders overload a shared resource.

It is **not** the same as a job burst. Ten thousand jobs becoming due simultaneously creates backlog; a herd occurs when many workers rush to coordinate simultaneously, even if only one job exists.

`SKIP LOCKED` avoids waiting on already-locked rows but does not eliminate database CPU, connection pressure, repeated index scans, or all contention.

### Jitter spreads polling requests

Instead of every worker sleeping exactly 1,000 ms:

```java
Thread.sleep(800 + ThreadLocalRandom.current().nextInt(401));
```

The randomized delay gradually spreads polls across time. It reduces peak concurrency, **not necessarily the total number of queries**. It can also increase discovery latency, so measure the tradeoff.

### Adaptive polling saves idle database work

A fixed interval of one second across 100 idle workers means up to 360,000 polling queries per hour. A bounded backoff policy can poll less often when no jobs are available, then reset after work appears.

But a long idle backoff can make newly due jobs late. A more advanced design may combine next-due-time awareness, notifications, and periodic fallback polling. PostgreSQL `LISTEN/NOTIFY` can be a wake-up hint, but not the sole durable source of truth.

### Capacity-aware batch claiming

Do not let one worker claim 1,000 jobs if it can run only 10 concurrently. It can strand work locally while other workers sit idle. Claim only as many as can be started promptly, or implement a carefully bounded local queue.

Separate polling from execution using a bounded executor. A long-running API call must not freeze the polling loop or a heartbeat thread. Apply rate limits for downstream services so a burst of eligible jobs does not become a burst of destructive API traffic.

### Indexes and database pressure

A useful starting point for a pending-job scan is:

```sql
CREATE INDEX jobs_pending_due_idx
ON jobs (scheduled_at, id)
WHERE status = 'PENDING';
```

Benchmark with realistic row counts and churn. Updates, vacuum behavior, large backlogs, and repeated polling can change performance substantially. `SKIP LOCKED` is not a substitute for query-plan analysis or capacity planning.

## 10. Recurring schedules are a different layer

One-time executions already have a concrete `scheduled_at`. Recurring schedules describe a **rule** such as “every day at 10 AM.”

Keep the definition separate from occurrences:

```text
job_definitions:
  definition_id, cron_expression, timezone, enabled, next_run_at

job_executions:
  execution_id, definition_id, scheduled_at, status
```

A scheduler can materialize due occurrences, while workers execute those occurrences. Use a uniqueness constraint such as `(definition_id, scheduled_at)` to prevent duplicate generation during failover. The exact key must account for your recurrence semantics.

Decide explicitly how to handle downtime and missed occurrences: catch up all missed runs, coalesce to one, or skip them. Also define time-zone and daylight-saving behavior, overlapping runs, cancellation, and whether a recurring definition can be modified while occurrences are pending.

A single leader may simplify recurrence generation, but idempotent occurrence creation and database uniqueness are still valuable because leaders can fail mid-operation.

## 11. A decision framework, not a technology checklist

| Requirement | Start with | Add complexity when |
|---|---|---|
| Time-based one-off jobs | PostgreSQL due-time query | Polling latency or dispatch throughput requires more |
| Concurrent workers | Atomic conditional claim / `SKIP LOCKED` | Ownership must extend across long execution |
| Worker crash recovery | Retry state and reclaim policy | Heartbeats and fencing are needed for stale attempts |
| Duplicate external calls | Stable business idempotency key | Gateway lacks strong deduplication; reconcile outcomes |
| Singleton recurring generation | Unique occurrence keys, optionally one coordinator | Exclusive leader role simplifies complex global work |
| Durable broker dispatch | Transactional outbox | A broker is actually justified |
| Worker throughput spikes | Bounded concurrency, batching, backpressure | Independent event buffering/scaling becomes valuable |
| Operational confidence | Metrics and failure injection | Production load exposes new bottlenecks |

The right architecture is rarely “use every mechanism.” Some mechanisms solve the same problem at different layers; others solve completely different problems. A leader lock is not a job claim. A job claim is not an idempotency guarantee. An outbox is not exactly-once delivery. A Kafka offset is not proof of external business success.

## 12. How to prove the design works

A serious engineering project should publish tests and measurements, not just an architecture diagram.

### Correctness experiments

1. Schedule 100 jobs at the same timestamp across three database-polling workers. Verify unique successful claims and eventual completion in the failure-free case.
2. Kill a worker immediately after committing `PROCESSING`. Verify that the configured recovery path makes the job eligible again.
3. Pause a worker until its lease expires. Reclaim with a new version; verify the old worker's conditional completion affects zero rows.
4. Simulate a gateway succeeding before the worker crashes. Verify a retry uses the same idempotency key and does not repeat the business effect under the mock gateway's specified contract.
5. Crash an outbox relay after Kafka acknowledges publication but before the relay records success. Verify that duplicate messages do not cause duplicate business effects.
6. Trigger Kafka rebalance while an operation is in flight. Verify behavior under overlapping attempts and correct offset handling.
7. Run the same workload with synchronized polling, jitter, and adaptive polling. Compare database load and p99 job-start latency.

### Metrics worth publishing

- Jobs claimed and completed per second.
- `started_at - scheduled_at` at p50, p95, and p99.
- Time from worker failure to successful recovery.
- Number of duplicate delivery attempts versus duplicate business effects.
- Claim-query latency, database connections, CPU, and lock contention.
- Backlog size and age of the oldest eligible job.
- Retry count, dead-letter count, and unresolved `UNKNOWN` outcomes.

Report hardware, database settings, worker counts, payload behavior, and test duration. Without those, “100,000 jobs per second” is a marketing claim, not an engineering result.

## 13. An incremental implementation path

For a Java 21, Spring Boot, PostgreSQL, Maven, Flyway, Testcontainers, and Docker Compose project:

**Version 1 — The correct baseline.** Build job creation, due-time eligibility, multiple worker processes, bounded batch claiming, execution, and conditional completion. Document the crash-recovery limitation rather than pretending it is solved.

**Version 2 — Failure recovery.** Introduce retry policy, per-job lease and heartbeat where appropriate, claim versions, and failure-injection tests. Separate retryable failures from ambiguous external outcomes.

**Version 3 — Efficient scheduling.** Add capacity-aware polling, jitter, backoff, indexing, metrics, and measured performance under bursts.

**Version 4 — Broker-backed dispatch.** Add Kafka only after establishing a reason to decouple dispatch. Implement the transactional outbox and test relay duplication, consumer crashes, and rebalances.

**Version 5 — Scheduling semantics and operations.** Add recurring definitions, time zones, missed-run policies, cancellation, priorities, dead-letter workflows, and dashboards.

Each version should be independently runnable and defensible. That gives us a meaningful comparison between architectures rather than a final system whose complexity cannot be explained.

## Conclusion: Reliability comes from explicit guarantees

The deceptively simple requirement “run this job at 10:00 AM” turns into a series of separate engineering questions:

- **When is it eligible?** A timestamp or another trigger defines readiness.
- **Who may claim it?** Atomic database updates coordinate concurrent workers.
- **Who owns an in-flight attempt?** Leases, heartbeats, and claim versions can coordinate recovery.
- **What if ownership is lost?** Fencing protects participating state updates, not arbitrary external side effects.
- **What if execution is repeated?** Idempotency or reconciliation protects the business effect.
- **How is work delivered?** Database polling may suffice; Kafka and an outbox are justified by specific transport and scaling needs.
- **What happens under load?** Batching, backpressure, polling strategy, and indexes determine operational behavior.

The strongest design is not the one with the most infrastructure. It is the one whose guarantees, failure modes, and tradeoffs are clearly understood—and whose claims can be reproduced in tests.

---

*Further reading: PostgreSQL documentation on [explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html), [transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html), and [advisory locks](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS); Apache Kafka [consumer configuration](https://kafka.apache.org/documentation/#consumerconfigs); and the [Transactional Outbox pattern](https://microservices.io/patterns/data/transactional-outbox.html).*
