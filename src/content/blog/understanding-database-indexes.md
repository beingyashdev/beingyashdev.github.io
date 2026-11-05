---
title: Understanding Database Indexes
description: How indexes accelerate lookups, why column order matters, and what they cost.
publishedDate: 2026-02-18
category: System Design
tags: [Databases, Performance, Fundamentals]
featured: false
sample: true
---
An index is an additional data structure that helps a database find rows without scanning every row. A B-tree index keeps keys ordered, making it useful for equality and range queries. Exact storage and optimizer behavior depend on the database engine.

## Start with a query

```sql
SELECT id, created_at
FROM orders
WHERE customer_id = 42
ORDER BY created_at DESC
LIMIT 20;

CREATE INDEX orders_customer_created_idx
ON orders (customer_id, created_at);
```

This composite index can help the engine locate a customer's entries and traverse them in time order. The leading column matters: an index on `(customer_id, created_at)` is not generally equivalent to one on `(created_at, customer_id)`. Whether the optimizer uses it depends on selectivity, statistics, the query, and the engine.

## Read the plan, measure the trade-off

Use your database's `EXPLAIN` facility to inspect access paths and, where safe, actual execution statistics. Indexes consume storage and increase the work of inserts, deletes, and updates. Add them for observed query patterns rather than indexing every column. Revisit the plan as data volume and distributions change.
