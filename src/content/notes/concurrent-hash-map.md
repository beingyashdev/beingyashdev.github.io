---
title: How ConcurrentHashMap works
date: 2026-03-04
category: Java
tags: [Collections, Concurrency]
related: [java-hashmap-concurrency-deep-dive-updated]
sample: true
---
`ConcurrentHashMap` supports concurrent access without a single lock around the whole map. Individual operations such as `putIfAbsent` are atomic, but a sequence of separate calls is not automatically atomic. Use methods such as `compute` for appropriate per-key updates, and keep remapping functions short.

```java
counts.merge(key, 1, Integer::sum);
```
