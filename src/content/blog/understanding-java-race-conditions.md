---
title: Understanding Java Race Conditions
description: Why correct-looking operations can fail when threads share mutable state, and how to choose a safer approach.
publishedDate: 2026-01-15
category: Java
tags: [Concurrency, Multithreading, Java Memory Model]
featured: true
sample: true
---
Two requests arrive at the same counter. Both read `41`, both add one, and both write `42`. Two increments happened, but the result only increased once. This is a race condition: the result depends on an uncontrolled ordering of operations across threads.

## The increment that isn't one operation

```java
class Counter {
    private int value;
    void increment() { value++; }
    int get() { return value; }
}
```

`value++` involves reading the value, computing a new value, and writing it back. The steps from two threads can interleave. Declaring `value` as `volatile` makes writes visible and orders certain operations, but it does not make this read-modify-write sequence atomic.

## Make the invariant explicit

If the invariant is simply “every increment is counted,” an atomic counter expresses it directly:

```java
import java.util.concurrent.atomic.AtomicInteger;

class Counter {
    private final AtomicInteger value = new AtomicInteger();
    void increment() { value.incrementAndGet(); }
    int get() { return value.get(); }
}
```

For a compound invariant involving several fields, protect all accesses participating in that invariant with the same lock. Atomics on individual fields do not automatically make a multi-field operation atomic.

```java
synchronized void transferTo(Account other, int amount) {
    // A real transfer also needs a consistent locking strategy for both accounts.
    if (balance < amount) throw new IllegalArgumentException();
}
```

## A practical debugging approach

Identify shared mutable state, list the invariants, and find every read and write. Then establish a happens-before relationship with synchronization or use a suitable concurrent abstraction. Tests with many threads can expose a race, but a passing stress test cannot prove its absence. Prefer immutable data or thread confinement when either removes sharing entirely.
