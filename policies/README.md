# IMA policies

FNR-3014 keeps delegation policy small and explicit. Agent tiers resolve only through configured `HIGH`, `MID`, `LOW`, and `vision` roles. Missing or incompatible minimum capability fails closed: HIGH and vision never silently downgrade or substitute. A child may receive only its definition's tools and authority.

A delegation request contains one to four complete assignments. Read roles cannot claim write scope; writing roles require repository-relative ownership; traversal, absolute paths, symlink escapes, duplicate IDs, and overlapping concurrent scopes are rejected before spawning. Writing children receive mechanically scoped `write`, `edit`, and deliberately narrow `bash` tools with realpath/symlink-safe ownership checks and fail-closed redirect classification. Every child gets a self-contained brief and cannot delegate further.

Only one retry is allowed, and only for a transient provider failure or a materially improved brief. Uncertain partial writes, unavailable/authenticated models, plan contradictions, and architecture, security, scope, or data-integrity decisions are narrow structured escalations, not broad model or phase promotion.

Initial review is always fresh. Reviewer reuse is limited to rereview or verified finding follow-up; implementation reuse is limited to implementation follow-up or review resolution; vision reuse remains within one visual thread. Session records retain only sanitized identity and status metadata. This is not a policy engine, workflow DSL, permission matrix, or telemetry system.
