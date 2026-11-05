---
title: ThreadLocal vs InheritableThreadLocal
date: 2026-03-02
category: Java
tags: [Concurrency, Multithreading]
related: [thread-pools-vs-virtual-threads]
sample: true
---
`ThreadLocal` associates a value with the current thread. `InheritableThreadLocal` can copy a parent value when a child thread is created; it does not propagate a fresh value each time a task is submitted to an existing pool thread. Remove thread-local values in a `finally` block when reusing workers, and consider explicit context passing when ownership is unclear.
