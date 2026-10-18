# Skill Registry (Phase 11)

This milestone adds a pure TypeScript registry for versioned skill manifests. It is not yet integrated into chat prompts or automatic filesystem discovery.

## Manifest shape

A manifest contains a stable lowercase `id`, semantic `version`, display `name`, `description`, plain-text `instructions`, a `keywords` list, and optional `enabled` boolean.

## Limits and selection

The registry accepts up to 100 skills, 12,000 instruction characters per skill, and 32 keywords per skill. A selection returns at most five enabled skills with at least one keyword-token overlap. Higher keyword overlap ranks first; ties sort by skill id. This is deterministic matching, not semantic retrieval.

## Trust boundary

Skill instructions are untrusted context. This module does not load files, execute scripts, register tools, or bypass tool approvals. A future loader must define workspace/user locations and trust behavior before connecting skills to prompts.
