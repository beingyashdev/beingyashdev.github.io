---
title: Redis cache eviction strategies
date: 2026-03-03
category: Backend Engineering
tags: [Redis, Caching]
related: [how-redis-caching-works]
sample: true
---
When Redis reaches its configured memory limit, its eviction policy determines what happens. Policies include approximate least-recently-used and least-frequently-used eviction, either across all keys or only keys with expiry, as well as `noeviction`. Choose based on whether the instance is a disposable cache or also holds data that must not be evicted. Monitor evictions and memory usage.
