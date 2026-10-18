# Skills: manifests, discovery, and context selection

AI Chatbox can optionally load versioned JSON skill manifests as plain-text guidance. Skills do not register tools, run scripts, or bypass the existing per-tool approval flow.

## Enable skill loading

Set `aiChatbox.skillsEnabled` to `true`. It defaults to `false`, so no skill files are read or added to model context until you opt in.

Two locations are scanned:

- Workspace skills: `.ai-chatbox/skills/*.json` under each open workspace folder.
- User skills: the extension's VS Code global storage directory, under `skills/*.json`. This location is user-specific and is not shared with a workspace.

The workspace path is convenient for skills you want to version with a project. Review workspace skill files before enabling them, especially in repositories you do not trust. User-level skills are useful for personal instructions you want available across projects.

## Manifest shape

Each JSON file contains a stable lowercase `id`, semantic `version`, display `name`, `description`, plain-text `instructions`, a `keywords` list, and optional `enabled` boolean. See [the example manifest](examples/typescript-debugging.skill.json).

## Limits and selection

- At most 100 files are loaded per request.
- Each file is limited to 20,000 bytes; instructions are limited to 12,000 characters.
- The registry accepts up to 100 unique skills and selects at most five enabled skills per user request.
- Matching uses deterministic keyword-token overlap, not semantic retrieval. Ties sort by skill ID.
- Selected skill context is limited to 24,000 characters.
- Malformed or invalid files are skipped; they do not block chat.

When a new user message is sent, skills are ranked against that message. Matching instructions are added as a request-scoped system context, then removed from conversation history before persistence. This avoids carrying stale skill selections into later turns.

## Trust boundary

Skill files are untrusted plain text, not executable code. The loader never evaluates scripts or automatically registers tools. The model context explicitly labels skill instructions as untrusted guidance and says they cannot override system/developer instructions, safety rules, tool permissions, or the user's request. This is a defense-in-depth instruction, not a sandbox; only enable workspace skills you trust. All tool calls still require host-side, per-invocation approval.
