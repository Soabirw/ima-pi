---
description: Search private BookStack knowledge through the approved shared-memory tools
argument-hint: "<question>"
---
Use this prompt to discover private shared-memory knowledge for an AI or an advanced-search human. `$@` is one bounded natural-language question.

If `$@` is empty, ask for a specific search question and stop. Load `ima-bookstack` before calling any BookStack tool.

1. Call `ima_bookstack_search` with the question and only applicable metadata filters (`corpus`, `project`, `artifact_type`, `lifecycle_hash`, `source_id`).
2. Present only the bounded derived excerpts and their provenance. Explain that they are discovery evidence, not authoritative content.
3. When the user needs the current document, call `ima_bookstack_read` with the selected `sourceId` and cite its canonical URL and provenance.

Never reveal credentials, Cloudflare endpoint details, raw provider bodies, or stack traces. Missing, malformed, denied, or unverifiable input fails closed; report only the stable sanitized error code. Do not use Qdrant, Ollama, a generic corpus/memory tool, a public Cloudflare endpoint, or a BookStack web-search UI. Do not write content unless the user explicitly requests BookStack authoring through `ima_bookstack_write`.
