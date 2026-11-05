---
title: Load Balancing Fundamentals
description: How traffic distribution, health checks, and failure handling fit together.
publishedDate: 2026-02-10
category: System Design
tags: [Load Balancing, Distributed Systems, Fundamentals]
featured: true
sample: true
---
A load balancer distributes incoming work across a set of targets. It can improve availability and help a service scale horizontally, but it cannot make unhealthy application instances healthy or remove every bottleneck.

## Choosing a target

Round-robin cycles through targets and works well when requests and instances are roughly similar. Least-connections considers active connections, which can help with uneven request durations. Hash-based routing can keep related requests together, although changes in membership can redistribute traffic.

## Layer 4 and layer 7

A layer 4 balancer makes decisions using transport information such as IP addresses and ports. A layer 7 reverse proxy understands application protocols and can route HTTP requests by host or path. The latter offers richer routing at the cost of more protocol processing and configuration.

## Health, retries, and state

Health checks should reflect whether an instance can serve the relevant traffic without cascading failures when a shared dependency is unavailable. Drain connections during deployments. Retries need limits, backoff, and awareness of idempotency: retrying a payment request blindly can create duplicate side effects. Avoid relying on sticky sessions as the only place important state lives.

Measure latency distributions, error rates, and per-target load. A balanced request count does not necessarily mean balanced CPU or equal user experience.
