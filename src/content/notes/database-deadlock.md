---
title: What happens during a database deadlock
date: 2026-03-05
category: System Design
tags: [Databases, Concurrency]
related: [understanding-database-indexes]
sample: true
---
A deadlock occurs when transactions wait on each other in a cycle. Many database engines detect the cycle and abort a victim transaction so the others can proceed. Keep transactions short, acquire locks in a consistent order, and retry aborted transactions with bounded backoff where the operation is safe to retry. Check the specific engine's diagnostics and isolation behavior.
