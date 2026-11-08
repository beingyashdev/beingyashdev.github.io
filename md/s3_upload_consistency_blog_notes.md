# Designing Reliable S3 Uploads: Metadata, Events, and PostgreSQL Concurrency

> Blog-ready working draft. Examples use PostgreSQL, S3 presigned PUT URLs, and SQS. Adapt naming and operational settings to your system.

## The problem

A client uploads media directly to S3 using a presigned URL. The backend stores post and media metadata in PostgreSQL. After S3 reports that an object was created, a worker marks the media uploaded or processed. Once every required media item is ready, the post can be published.

This seemingly simple flow has several distributed-systems challenges:

- How do we associate an S3 object with a database record?
- What if the backend crashes after upload but before updating metadata?
- What if notifications are duplicated, delayed, or missed?
- How does the backend know which upload is the *last* one?
- Can two concurrent PostgreSQL transactions both miss the moment when the post becomes ready?
- Does `REPEATABLE READ` or `SERIALIZABLE` solve that race?

## 1. Create metadata before uploading

The backend should create an upload intent *before* returning a presigned URL.

```text
Client -> Backend: POST /posts/{postId}/media/initiate
Backend -> PostgreSQL: INSERT media(upload_id, post_id, s3_key, status='PENDING')
Backend -> Client: presigned PUT URL + upload_id
Client -> S3: PUT file bytes
```

The database commit must succeed before the URL is returned. The S3 key can include a generated upload ID, for example `staging/{userId}/{uploadId}`. This gives each upload a stable correlation key; the S3 notification's bucket/key identifies the media record.

The backend can additionally require signed `x-amz-meta-upload-id` metadata, but it should not rely on user-supplied metadata as proof of ownership. Authenticate the initiating request, constrain the key and upload properties, and verify the resulting object.

**Key distinction:** The database is the application metadata source of truth; S3 is the source of truth for whether the object exists. These two stores are not updated in one atomic transaction.

## 2. Use explicit states

Example media states:

```text
PENDING -> UPLOADED -> PROCESSING -> PROCESSED
                         \-> FAILED
PENDING -> EXPIRED
```

`UPLOADED` means the object exists and passes upload-level checks. `PROCESSED` means any required transformations, scanning, and validation are complete. Do not conflate the two.

Example post states:

```text
DRAFT -> PUBLISH_REQUESTED -> PUBLISHED
                          \-> FAILED / NEEDS_ATTENTION
```

A post may have multiple media rows. Upload completion does not by itself mean the user requested publication.

## 3. Durable event processing and crash recovery

Recommended simple architecture:

```text
Client --presigned PUT--> S3
                            |
                            v
                       ObjectCreated
                            |
                            v
                         SQS queue
                            |
                            v
                          Worker
                            |
                            v
                       PostgreSQL
```

Worker sequence:

1. Receive the SQS message.
2. Correlate it with a media record by bucket/key (and version ID if versioning is used).
3. Verify the object with `HeadObject`, and validate its expected properties.
4. Apply an idempotent database transition.
5. Delete the queue message **only after** the database transaction commits.

If the worker crashes before deleting the message, it can be redelivered after the visibility timeout. If it crashes after committing but before deleting, the operation must safely tolerate a duplicate. Configure retries, a dead-letter queue, monitoring, and visibility timeout appropriate to processing duration.

S3 event notifications are generally at-least-once and can be delayed or delivered out of order. Durable queuing reduces the risk of worker crashes losing work, but it does **not** create an atomic transaction between S3 object creation and queue delivery.

### Reconciliation is still necessary

A scheduled job scans stale `PENDING` or `PROCESSING` rows, checks S3 and processing state, and retries or expires them. Use indexed, bounded scans and distinguish a genuinely missing object from an upload still in progress. Reconciliation covers missing notifications and stuck state transitions.

A client `POST /uploads/{id}/complete` callback can reduce latency, but must not be the only mechanism: the client may disconnect after a successful S3 PUT. Both callback and S3-event paths should use the same idempotent state-transition logic.

### Kafka instead of SQS?

Kafka is appropriate if the platform already operates Kafka, needs retained replay, or has many independent event consumers. An integration (for example, S3 -> EventBridge -> integration -> Kafka) is required; S3 does not natively send its standard event notifications straight to Kafka. Consumers should commit offsets after the database transaction commits and still handle duplicates. Kafka's exactly-once features do not automatically make arbitrary external PostgreSQL updates exactly-once.

## 4. Content-addressed keys versus upload-addressed keys

An upload-addressed staging key uses a random upload identifier:

```text
staging/user-42/upload-abc
```

Content-addressable storage (CAS) instead derives the canonical object identifier from file bytes, commonly SHA-256:

```text
objects/sha256/ab/cd/<full-sha256>
```

This enables deduplication of byte-identical files. However:

- A client-declared hash must be verified; do not trust it as proof of content.
- Do not expose private object existence or grant access solely because a user knows a hash.
- Concurrent identical uploads need atomic database coordination and safe object publishing.
- Multipart S3 ETags are not generally SHA-256 (or a reliable full-file MD5).
- Staging uploads under unique keys and later promoting verified bytes to a canonical hash key is often simpler than signing a direct PUT to a shared canonical key.

`upload_id`, `post_id`, `content_hash`, and `s3_key` serve different purposes. Multiple logical posts can reference one deduplicated physical object.

## 5. How does the backend know the final file arrived?

**It cannot infer the final file from the order of S3 notifications.** The application must establish a complete media manifest.

For a post with three images:

```text
posts:  P1, expected_media=3, status=PUBLISH_REQUESTED
media:  M1(P1), M2(P1), M3(P1)
```

The client can declare all expected media at initiation, or explicitly finalize a draft with `POST /posts/P1/publish`. Finalization freezes the media set; later uploads must not silently change the required count. Publish only when every required media row is `PROCESSED` and the user has requested publication.

## 6. The two-transaction race under READ COMMITTED

Initial state:

| Media | State |
|---|---|
| M1 | PROCESSED |
| M2 | PROCESSING |
| M3 | PROCESSING |

`P1` is `PUBLISH_REQUESTED` with three expected media items.

Two workers run concurrently, each marking a different row processed and then counting ready media **inside the same transaction**:

| Time | Transaction T1 | Transaction T2 |
|---|---|---|
| 1 | `BEGIN` | `BEGIN` |
| 2 | Update M2 to PROCESSED | |
| 3 | | Update M3 to PROCESSED |
| 4 | Count processed: 2 (M1 + own M2) | |
| 5 | | Count processed: 2 (M1 + own M3) |
| 6 | No publish; `COMMIT` | No publish; `COMMIT` |

Final state: all three media rows are processed, but the post is still `PUBLISH_REQUESTED`.

Under PostgreSQL `READ COMMITTED`, each statement sees a snapshot of committed changes as of the statement start plus the transaction's own changes. Neither transaction sees the other's uncommitted update.

**Important precision:** This is a *missed-finalization race*, not necessarily classic write skew violating a database invariant. The desired workflow has failed to make progress, even though both database transactions can commit legitimately.

## 7. Why PostgreSQL REPEATABLE READ does not fix it

In PostgreSQL, `REPEATABLE READ` provides snapshot isolation. If both transactions establish their snapshots before either commits, T1 still sees M1 + M2 and T2 sees M1 + M3. They update different media rows, never attempt to write the shared post row, and can both commit. The post remains unpublished.

A concurrent attempt to update the *same* row under PostgreSQL `REPEATABLE READ` may instead produce SQLSTATE `40001` (`could not serialize access due to concurrent update`), requiring a full transaction retry. But that conflict does not occur when both workers decide not to touch the post.

**Serializable nuance:** Even `SERIALIZABLE` does not automatically repair this workflow. If the operations and their ordering admit a valid serial execution that leaves the post pending, serializability alone cannot guarantee eventual publication. Strong isolation protects execution semantics, not application liveness. Design the transition logic so a completing worker reliably detects the last completion, or add reconciliation.

## 8. Fix A: Coordinate on the parent post row

All workers processing media for a post first lock its parent row, *before* changing a media state. With PostgreSQL `READ COMMITTED`:

```sql
BEGIN;

SELECT post_id
FROM posts
WHERE post_id = :post_id
FOR UPDATE;

UPDATE media
SET status = 'PROCESSED'
WHERE media_id = :media_id
  AND post_id = :post_id
  AND status = 'PROCESSING';

UPDATE posts p
SET status = 'PUBLISHED'
WHERE p.post_id = :post_id
  AND p.status = 'PUBLISH_REQUESTED'
  AND p.expected_media = (
    SELECT COUNT(*)
    FROM media m
    WHERE m.post_id = p.post_id
      AND m.status = 'PROCESSED'
  );

COMMIT;
```

The parent-row lock makes T2 wait while T1 completes. After T1 commits, T2 obtains the lock, marks its own media processed, and its new `READ COMMITTED` statement sees all three ready rows. T2 publishes the post.

**The locking protocol must be universal:** all relevant writers, including retries and media-set changes, must coordinate on the same post row. Do not update media first and only then acquire the parent lock; that can reintroduce a stale-count race or deadlocks. Under `REPEATABLE READ`, a transaction that waits on a concurrently modified parent row may fail with SQLSTATE `40001`, so retry the whole transaction.

For production, also check the media update's affected-row count and distinguish an already-processed duplicate from an invalid state transition. Keep the expected media manifest immutable after publication is requested.

## 9. Fix B: Idempotent atomic completion counter

A more scalable alternative avoids recounting all child rows. Store `processed_media` on the post and increment it exactly once per successful media transition, in the **same database transaction**:

```sql
BEGIN;

UPDATE media
SET status = 'PROCESSED'
WHERE media_id = :media_id
  AND post_id = :post_id
  AND status = 'PROCESSING'
RETURNING media_id;

-- Only if the preceding UPDATE returned a row:
UPDATE posts
SET processed_media = processed_media + 1
WHERE post_id = :post_id
RETURNING processed_media, expected_media, status;

-- In the same transaction, if all required media are ready:
UPDATE posts
SET status = 'PUBLISHED'
WHERE post_id = :post_id
  AND status = 'PUBLISH_REQUESTED'
  AND processed_media = expected_media;

COMMIT;
```

PostgreSQL serializes concurrent updates to the same post counter row. If M2 and M3 complete concurrently, the increments become 2 and then 3 (in some order). The second transaction can publish. A duplicate completion doesn't increment again because its conditional media update affects zero rows.

Implementation detail: the application must execute the counter update **only if** the media transition actually happened, and all steps must be in one transaction. This example assumes a fixed expected-media manifest and no concurrent deletion or reset of processed media. For stricter invariants, enforce allowed transitions and handle counter reconciliation.

## 10. Publishing side effects: use an outbox

A database transition to `PUBLISHED` and a Kafka/SQS `PostPublished` event cannot be atomically committed by simply calling the broker after SQL `COMMIT`.

Insert an outbox row in the same PostgreSQL transaction that first changes the post status to `PUBLISHED`. A separate publisher retries delivery. Consumers must remain idempotent, because outbox delivery can also duplicate messages.

## 11. Failure-mode checklist

| Failure | Mitigation |
|---|---|
| Client never uploads after URL issued | Expiration and cleanup |
| Client disconnects after successful PUT | S3 event path and reconciliation |
| Worker crashes before DB commit | SQS redelivery / Kafka offset replay |
| Worker crashes after DB commit, before acknowledgment | Idempotent transitions |
| S3 notification never reaches queue | Scheduled reconciliation |
| Duplicate or out-of-order events | State-machine checks, version identity, idempotency |
| Presigned URL reused to overwrite a key | Unique keys, overwrite restrictions, or S3 versioning |
| Two media workers complete simultaneously | Parent-row lock or atomic completion counter |
| Post published in DB but event publishing crashes | Transactional outbox |
| One required media upload fails | Retry, expire, or surface a failed-post state |

## 12. Final architecture

```text
                    +--------------------+
Client --initiate--> | Backend API        | --insert intent--> PostgreSQL
   |                +--------------------+                    ^
   |                     | presigned URL                       |
   +-------- PUT --------+------> S3                           |
                                  |                            |
                                  v                            |
                             SQS standard queue                |
                                  |                            |
                                  v                            |
                            Upload/Media Worker ---------------+
                                  |                            |
                                  +--> processing / validation |
                                                               |
Scheduled Reconciler --check stale rows & S3-------------------+
                                                               |
Post PUBLISHED transaction --> outbox row --> event publisher --+--> downstream consumers
```

## Conclusion

A reliable direct-to-S3 upload design does not rely on guessing which S3 event is last. It creates upload metadata first, freezes a post's expected media manifest, uses durable asynchronous delivery, and makes state transitions idempotent. The database transaction that completes a media item must also coordinate the post-level readiness decision. PostgreSQL `REPEATABLE READ` alone cannot prevent a missed-finalization race: either lock the shared post row, use an atomic completion counter, or provide a carefully designed finalization worker. Reconciliation remains a valuable safety net for distributed failures.

**Interview takeaway:** Durability, isolation, and liveness solve different problems. SQS/Kafka help retain work, PostgreSQL locking or atomic counters coordinate concurrent state changes, and reconciliation repairs work that never reached its expected state.
