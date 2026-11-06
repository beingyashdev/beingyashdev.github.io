---
title: PostgreSQL Transaction Isolation Through Concurrent Inventory Orders
description: A detailed guide to MVCC snapshots, row locks, isolation levels, write skew, and retries using practical PostgreSQL inventory examples.
publishedDate: 2026-11-06
category: Backend Engineering
tags: [PostgreSQL, Databases, Concurrency, Spring Boot, Transactions]
featured: true
draft: false
---

*From MVCC snapshots to dirty reads, phantom reads, row locks, and serialization failures.*

When two customers try to buy the last few units of a product, what does PostgreSQL actually do? Does the second transaction wait? Does it see the first transaction's changes? Does it fail? The answers depend on the operation and isolation level.

This guide builds the mental model step by step using an inventory table and two concurrent transactions, T1 and T2.

## 1. Start with atomicity versus isolation

**Atomicity** means all changes in a transaction commit or roll back together. **Isolation** governs how concurrent transactions see and affect each other's changes. These are different guarantees.

For example, an order can deduct stock from two distribution centers and insert an order in one database transaction. If any required deduction fails, the application rolls back the entire transaction. The isolation level determines what happens if other transactions are updating those same stock rows concurrently.

## 2. The inventory example

```sql
CREATE TABLE inventory (
    dc_id BIGINT NOT NULL,
    item_id BIGINT NOT NULL,
    qty INTEGER NOT NULL CHECK (qty >= 0),
    PRIMARY KEY (dc_id, item_id)
);

INSERT INTO inventory (dc_id, item_id, qty)
VALUES (1, 101, 5);
```

Two customers each request three units from the same DC:

```sql
UPDATE inventory
SET qty = qty - 3
WHERE dc_id = 1 AND item_id = 101 AND qty >= 3;
```

The `qty >= 3` predicate matters: it prevents a successful update from making quantity negative. Check the affected row count; zero means the requested deduction did not succeed. Validate that every requested quantity is a positive integer before executing the statement: a negative request would otherwise increase stock. Zero rows can also mean the inventory row does not exist, so distinguish that case if the application needs a different error.

## 3. What an MVCC snapshot actually is

PostgreSQL uses **multi-version concurrency control (MVCC)**. Updating a row creates a new row version; old versions can remain visible to transactions with older snapshots.

A snapshot is **not a copy of the whole database**. It is transaction visibility information used to determine which row versions are visible when a query accesses them. PostgreSQL generally lets ordinary `SELECT` statements read visible versions without waiting for row-update locks. A transaction also sees its own earlier writes, even though other transactions cannot see them before commit.

For a `REPEATABLE READ` transaction, the snapshot is normally established by the first statement that needs one, **not by `BEGIN` itself**. That snapshot is then reused for subsequent ordinary reads. Under `READ COMMITTED`, ordinary statements get a fresh statement snapshot.

## 4. Dirty reads: reading uncommitted changes

Imagine quantity is initially 10:

| Time | T1 | T2 |
|---|---|---|
| 1 | `BEGIN` | |
| 2 | `UPDATE ... SET qty = 5` (not committed) | |
| 3 | | Reads `qty = 5` (hypothetical dirty read) |
| 4 | `ROLLBACK` | |

T2 would have read a value that never became committed. **PostgreSQL does not permit dirty reads**: even `READ UNCOMMITTED` behaves like `READ COMMITTED`, so T2 sees the previously committed quantity 10 in this example.

## 5. Non-repeatable reads: same row, changed value

Under `READ COMMITTED`:

| Time | T1 | T2 |
|---|---|---|
| 1 | | `BEGIN` |
| 2 | | `SELECT qty` → 10 |
| 3 | `UPDATE qty = 5; COMMIT` | |
| 4 | | `SELECT qty` → 5 |

Both reads see committed data, but the same row returns a different value. That is a **non-repeatable read**.

Under `REPEATABLE READ`, if T2 established its snapshot before T1 committed, its second ordinary `SELECT` still returns 10.

## 6. Phantom reads: the set of matching rows changes

Suppose `SELECT * FROM inventory WHERE qty > 5` initially returns items A and B. Another transaction inserts item C with quantity 12 and commits. Under `READ COMMITTED`, repeating the query can return A, B, and C. **C is a phantom row.**

Phantoms can also appear because an existing row is updated so it starts matching the predicate, or disappear because of a delete or an update that makes a row stop matching.

The useful distinction is:

- **Non-repeatable read:** an existing row's observed value changes.
- **Phantom read:** the set of rows satisfying a predicate changes.

PostgreSQL `REPEATABLE READ` prevents both for ordinary snapshot reads, even though the SQL standard permits phantoms at that level.

## 7. What happens when two transactions UPDATE the same row?

Return to `qty = 5`, with both customers requesting three units. Assume T2 has established its snapshot before T1 commits.

### READ COMMITTED

1. T1 updates quantity from 5 to 2 and holds the row lock.
2. T2 attempts the same `UPDATE` and waits.
3. T1 commits.
4. T2 re-evaluates the update condition against the newly committed row version.
5. `qty >= 3` is false, so T2 updates **zero rows**.

This is not a dirty read. PostgreSQL uses special handling for concurrent updates: it does not simply rerun the entire statement with a new snapshot.

### REPEATABLE READ

1. T2's snapshot was established before T1 committed.
2. T2 attempts to update the same row and may wait for T1's row lock.
3. T1 commits.
4. PostgreSQL raises `SQLSTATE 40001`: **could not serialize access due to concurrent update**.

The application must roll back and retry the **whole transaction**, not merely rerun a single SQL statement within the failed transaction.

### SERIALIZABLE

For this same-row conflict, the outcome is similar to `REPEATABLE READ`: T2 may wait and then receive a serialization failure. **Serializable does not automatically fail immediately upon encountering a locked row.** It additionally detects non-serializable dependency patterns that can arise even when transactions modify different rows.

If T1 rolls back instead of committing, T2 may proceed. If T2's snapshot is established only after T1 commits, T2 can see the new value and update zero rows without that particular snapshot conflict.

## 8. Snapshot first or wait first?

This detail generated an especially useful question: does T2 notice a lock, wait, and then take its snapshot—or take the snapshot before attempting the update?

For a `REPEATABLE READ` transaction whose first snapshot-requiring statement is an `UPDATE`, the conceptual sequence is:

```text
BEGIN REPEATABLE READ
    ↓
UPDATE starts; establish transaction snapshot
    ↓
Find candidate row versions
    ↓
Attempt row update
    ↓
Encounter T1's row lock; wait
    ↓
T1 commits
    ↓
Detect update made after T2's snapshot
    ↓
Serialization failure (40001)
```

PostgreSQL does not take a snapshot *because* a row is locked. It needs a snapshot to execute the statement and determine row visibility. If an earlier query already established the transaction snapshot, the `UPDATE` reuses it.

A normal `SELECT` is different: it can continue reading the older visible version without waiting for the row-update lock. `SELECT ... FOR UPDATE`, `UPDATE`, and `DELETE` may need to wait because they seek to lock or modify rows. Ordinary `SELECT` can still wait for certain table-level locks, such as an `ACCESS EXCLUSIVE` lock.

## 9. Why Serializable is stronger than Repeatable Read

PostgreSQL `REPEATABLE READ` provides snapshot isolation and prevents dirty reads, non-repeatable reads, and phantom reads for ordinary reads. But **write skew** remains possible.

Imagine two doctors are on call. A rule says at least one must remain on call. Each transaction reads both doctors as on call, then each updates a *different* doctor's row to off call. Under snapshot isolation, both may commit, violating the rule because they do not update the same row.

`SERIALIZABLE` uses Serializable Snapshot Isolation (SSI) to detect dangerous dependency structures and abort a transaction when necessary. It may also raise serialization errors in cases that do not involve waiting on the same row lock.

This is why the isolation levels differ in more than their handling of a single `UPDATE`.

## 10. When conditional UPDATE is not enough: cross-row invariants

An atomic conditional `UPDATE` protects the row it changes, but it does **not automatically protect a business rule involving other rows**. This distinction matters even if the business condition appears directly inside the `WHERE` clause.

Imagine two distribution centers, both initially active, with the rule **at least one DC must remain active**:

```sql
CREATE TABLE dc (
    dc_id BIGINT PRIMARY KEY,
    active BOOLEAN NOT NULL
);
INSERT INTO dc VALUES (1, TRUE), (2, TRUE);
```

Two administrators concurrently deactivate different DCs. Each uses a conditional `UPDATE`:

```sql
-- Transaction T1
UPDATE dc
SET active = FALSE
WHERE dc_id = 1
  AND EXISTS (
      SELECT 1 FROM dc WHERE dc_id = 2 AND active = TRUE
  );
```

```sql
-- Transaction T2
UPDATE dc
SET active = FALSE
WHERE dc_id = 2
  AND EXISTS (
      SELECT 1 FROM dc WHERE dc_id = 1 AND active = TRUE
  );
```

Under **READ COMMITTED**, if the statements overlap and each statement's snapshot sees both DCs active, both predicates can be true. Under **REPEATABLE READ**, each transaction can likewise see both DCs active in its fixed snapshot. T1 changes DC1 while T2 changes DC2, so there is no same-row write conflict forcing one to fail. Both can commit, leaving **zero active DCs**. This is a form of **write skew**.

| Moment | T1 | T2 |
|---|---|---|
| Initial state | DC1 and DC2 active | DC1 and DC2 active |
| Predicate read | Sees DC2 active | Sees DC1 active |
| Update | Deactivates DC1 | Deactivates DC2 |
| Commit under RC or RR | Can succeed | Can succeed |
| Final state | **Both inactive: invariant violated** | |

Why didn't `WHERE EXISTS` save us? Because it **reads another row without coordinating changes to that row**. A predicate in an `UPDATE` is not a global lock on every row it consults.

### Three ways to enforce the invariant

**1. Shared coordination lock under READ COMMITTED.** Have every transaction that changes DC activation lock the same parent row, *then* check the current DC state and update:

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;

SELECT group_id
FROM dc_groups
WHERE group_id = 1
FOR UPDATE;

-- After acquiring the shared coordination lock, check
-- the currently active DCs and reject an unsafe change.
-- Then update the chosen DC.

COMMIT;
```

All writers affecting that invariant must follow this protocol. A transaction-level advisory lock is another coordination option. Simply locking one target DC row is not sufficient when the other transaction updates a different DC. With `REPEATABLE READ`, waiting for a lock does not refresh an older transaction snapshot, so design the protocol with that limitation in mind.

**2. SERIALIZABLE isolation with retries.** If both transactions read the relevant predicate and try to commit an outcome that cannot correspond to a serial execution, PostgreSQL's SSI mechanism can abort one with SQLSTATE `40001`. The application must retry the **entire transaction**, including the invariant check. Every transaction that can affect the invariant must participate in the correctness strategy.

**3. Database-enforced constraints where practical.** A `CHECK (qty >= 0)` constraint protects a single inventory row. Unique, exclusion, foreign-key, or redesigned aggregate/coordination rows can enforce other rules. A normal row-level `CHECK` constraint cannot directly enforce an arbitrary cross-row count such as “at least one DC active.”

### Do multiple inventory deductions require SERIALIZABLE?

**No—not just because multiple rows are involved.** Suppose an order allocates 2 units from DC1 and 3 from DC2. If each deduction uses `WHERE qty >= requested`, all deductions run in **one transaction**, and the application verifies that every required allocation succeeded before committing, it can safely enforce the independent nonnegative-stock constraints under `READ COMMITTED`. If any allocation fails, roll back the entire transaction. Acquire or update rows in a consistent order across transactions to reduce deadlock risk; consistent ordering reduces risk but cannot eliminate every deadlock.

That is different from a rule such as **“the combined inventory across all DCs must remain at least 10 units”**. Two transactions can each observe an adequate total and deduct from *different* DC rows, collectively breaking the shared threshold. That cross-row rule needs coordination, a suitable database representation/constraint, or `SERIALIZABLE` with retries.

**Rule of thumb:** Ask whether two concurrent transactions can each satisfy their own condition while their combined committed result violates a business invariant. If yes, an atomic `UPDATE` by itself may not be enough.

## 11. PostgreSQL isolation comparison

| Behavior | READ COMMITTED | REPEATABLE READ | SERIALIZABLE |
|---|---|---|---|
| Dirty reads | Prevented | Prevented | Prevented |
| Non-repeatable reads | Possible | Prevented | Prevented |
| Phantom reads | Possible | Prevented | Prevented |
| Snapshot for ordinary reads | Per statement | Per transaction | Per transaction + SSI checks |
| Concurrent same-row UPDATE | Wait, recheck committed version | May wait, then `40001` | May wait, then `40001` |
| Write skew | Possible | Possible | Prevented via serialization checks |

`READ UNCOMMITTED` is accepted by PostgreSQL but behaves as `READ COMMITTED`.

## 12. Which isolation level should an inventory system choose?

For a straightforward stock deduction, **start with `READ COMMITTED` plus a conditional update**:

```sql
UPDATE inventory
SET qty = qty - :requested_qty
WHERE dc_id = :dc_id
  AND item_id = :item_id
  AND qty >= :requested_qty
RETURNING qty;
```

This makes the stock constraint part of the atomic database operation. When a transaction includes several item/DC deductions and order creation, keep them inside one transaction. If any required allocation is missing, **ROLLBACK** all changes.

For example, a batch update can use `UPDATE ... FROM (VALUES ...)` and `RETURNING dc_id, item_id` to identify which allocations succeeded. A missing allocation does not automatically make the SQL statement fail; the application must compare expected and updated allocations and roll back when incomplete. Validate positive quantities, and combine or reject duplicate `(dc_id, item_id)` entries before an `UPDATE ... FROM`: if multiple source rows match one target row, PostgreSQL does not guarantee which matching source row supplies the update.

A broader business invariant spanning multiple rows may require additional locking, a carefully designed transaction, or `SERIALIZABLE` with retry logic. Isolation choice should follow the actual invariant, not a rule that stronger is always better.

## 13. How to configure isolation in Spring Boot

With Spring transaction management, isolation is commonly set at the service layer:

```java
@Service
public class OrderService {
    @Transactional(isolation = Isolation.READ_COMMITTED)
    public void placeOrder(OrderRequest request) {
        // Conditional inventory deductions
        // Verify all required rows were updated
        // Persist order and order items
        // Throw a runtime exception if any allocation fails
    }
}
```

Spring normally rolls back on an uncaught runtime exception. Under default `Propagation.REQUIRED`, a method joining an existing transaction inherits the existing transaction's isolation rather than replacing it. Proxy-based self-invocation can also bypass `@Transactional` advice. When Order and Inventory live in separate databases, a normal local `@Transactional` does not create a distributed ACID transaction.

## 14. Practical takeaways

1. A PostgreSQL snapshot is a **visibility rule**, not a database copy.
2. Ordinary reads usually don't wait for row-update locks; writes may.
3. `READ COMMITTED` can recheck an updated row after waiting.
4. `REPEATABLE READ` can instead fail with `40001` if a row changed after its snapshot.
5. `SERIALIZABLE` behaves similarly for that same-row conflict but also protects against more complex anomalies.
6. Conditional updates plus transactions are often sufficient for nonnegative inventory, without needing the strongest isolation level.
7. Retry serialization failures at the transaction boundary, and make order creation idempotent when clients may retry requests.

**The core lesson:** Atomicity answers whether a set of changes commits together. Isolation answers what concurrent transactions are allowed to observe and how conflicting operations are resolved. Understanding both is essential for building inventory and ordering systems that remain correct under load.

## 15. Try the same-row conflict in two sessions

Use two separate `psql` connections to the same database. Run the setup once and reset `qty` to `5` between experiments. The second session intentionally blocks; switch back to the first session to commit it. Do not run these examples against production data.

In session A:

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
UPDATE inventory SET qty = qty - 3
WHERE dc_id = 1 AND item_id = 101 AND qty >= 3
RETURNING qty;  -- 2; leave this transaction open
```

In session B, execute the same update inside its own transaction. It waits for A:

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
UPDATE inventory SET qty = qty - 3
WHERE dc_id = 1 AND item_id = 101 AND qty >= 3
RETURNING qty;  -- waits until A finishes
```

Now run `COMMIT;` in A. B resumes, returns no rows because `2 >= 3` is false, and can then `COMMIT;`. To repeat with `REPEATABLE READ`, reset the row to `5`, change B's `BEGIN` to `BEGIN ISOLATION LEVEL REPEATABLE READ`, and start its update before A commits. After A commits, B receives `40001` instead; issue `ROLLBACK;` in B before starting a fresh transaction. This experiment assumes B reaches the update while A's update is still uncommitted.

## 16. Design the retry boundary deliberately

Both `REPEATABLE READ` and `SERIALIZABLE` can return `40001`. Retry the full transaction from outside its transaction boundary: start a new transaction, reread the data, re-evaluate the business decision, and attempt the writes again. A retry around only the last statement cannot reconstruct decisions made from an earlier snapshot. Errors can surface at commit, so the retry must cover commit too.

A practical policy is a small, bounded number of attempts with exponential backoff and jitter, followed by an observable failure. `40P01` (deadlock detected) can also be retryable when the operation is safe to repeat; do not blindly retry every database error. A zero-row conditional update is normally a business outcome, not a serialization failure.

```text
for each bounded attempt:
    begin a new transaction
    try:
        read current state and make the decision again
        perform all required conditional updates
        create the order
        commit
        return success
    catch SQLSTATE 40001 (or a safely retryable 40P01):
        rollback if needed
        wait with bounded backoff and jitter
fail visibly after the final attempt
```

This is pseudocode: in Spring, put the retry outside the proxied transactional call, so every attempt enters a new transaction and the caller can catch a failure raised during commit. Avoid sending email, charging a card, or publishing a message directly inside a retryable transaction: the database rollback cannot undo an external side effect. Use an idempotency key for repeated order requests and consider a transactional outbox for reliable event publication. Retries handle database conflicts; idempotency also addresses a client retry after a successful commit whose response was lost.

## References

- [PostgreSQL: transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL: serialization failure handling](https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html)
- [PostgreSQL: UPDATE and FROM](https://www.postgresql.org/docs/current/sql-update.html)
- [Spring Framework: transaction propagation](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/tx-propagation.html)
- [Spring Framework: declarative transaction annotations](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/annotations.html)
