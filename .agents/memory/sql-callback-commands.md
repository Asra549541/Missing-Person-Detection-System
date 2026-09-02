---
name: SQL callback command handling
description: Constraint to remember when using the workspace database query callback.
---

The workspace SQL callback executes prepared statements and rejects multiple SQL commands in one call.

**Why:** A multi-statement seed/update attempt failed before any changes were applied.

**How to apply:** Send one statement per callback invocation, or use a project migration/seed script for ordered batches.