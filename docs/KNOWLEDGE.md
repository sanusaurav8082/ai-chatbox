# Local knowledge: indexing and retrieval

AI Chatbox can optionally retrieve relevant excerpts from local Markdown and text documents and include them in the current model request. The first version is intentionally small: deterministic lexical ranking, no embeddings, no remote index, and no persisted index.

## Enable it

Set `aiChatbox.knowledgeEnabled` to `true`. It defaults to `false`; no knowledge files are read while disabled.

The extension scans only these locations:

- Workspace: `.ai-chatbox/knowledge/*.md`, `.markdown`, and `.txt` files in open workspace folders.
- User-level: files with those extensions in the extension's VS Code global storage directory under `knowledge/`.

Put personal reference notes in user storage if they should not be committed with a project. Workspace knowledge is useful for reviewed project architecture notes, runbooks, or team conventions. Review source files before enabling retrieval in an unfamiliar repository.

## How retrieval works

1. For each user message, the extension reads the bounded allowlisted files.
2. Markdown is treated as text; headings provide titles and blank-line-separated paragraphs become chunks.
3. A deterministic lexical scorer ranks chunks by query-token overlap, with small boosts for matching file paths and titles.
4. Up to five excerpts (at most 12,000 characters combined) are added as request-scoped context.
5. The prompt includes source paths so the model can cite which local files informed its answer.

The index is rebuilt in memory per request; no content index is persisted. The implementation does not use embeddings, a vector database, or an external search service.

## Limits

- Maximum 100 files per request.
- Maximum 50,000 bytes per file and 1,000,000 bytes across accepted files.
- Maximum 500 chunks; each chunk is at most 1,600 characters.
- Maximum five results and 12,000 characters of injected context.
- Only Markdown and plain-text files in the documented directories are read. Arbitrary workspace files, source code, binaries, and hidden credentials are not indexed by this feature.
- Invalid/unreadable/oversized files are skipped or bounded; retrieval failures should not block ordinary chat.

See [the example runbook](examples/knowledge/release-runbook.md).

## Trust and privacy

Retrieved documents are untrusted reference material, not instructions. The context tells the model to use them only when relevant, cite their paths, and never let document content override system/developer instructions, safety rules, tool permissions, or the user's actual request. This is defense in depth, not a guarantee that a model will always resist prompt injection.

When enabled, matching excerpts are sent to the configured model provider as part of the request. With a remote provider, those excerpts leave the machine according to that provider's API behavior. Keep sensitive files out of the knowledge folders and disable the setting when you do not want retrieval. The feature does not change tool permissions; every tool call still requires separate approval.
