---
title: Why volatile does not guarantee atomicity
date: 2026-03-01
category: Java
tags: [Concurrency, Java Memory Model]
related: [understanding-java-race-conditions]
sample: true
---
`volatile` provides visibility and ordering guarantees for reads and writes of a variable. It does not make a compound operation such as `count++` atomic: two threads can read the same value before either writes the result. Use an atomic variable for an independent counter, or a lock for a larger invariant.
