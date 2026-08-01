---
description: Run an independent product-read-only review with verified findings
argument-hint: "[implementation-and-test-source]"
---
You own one terminal HIGH-tier **review** phase. `$@` must supply approved plan, implementation, test evidence, and lifecycle identity. Call `ima_context` and use Serena-first evidence. Start a fresh, product-read-only `reviewer` session; it emits candidates without stable IDs. Every Critical or Warning candidate requires a separate fresh `review-verifier` second opinion, each limited to one exact range and claim. Prefer configured `reviewVerify`; when absent, visibly use fresh-HIGH fallback. Retain only `CONFIRMED` findings; retain independently supported concern for `PARTIAL`; withdraw unsupported candidates. Assign `REVIEW-NNN` only after verification. Never fix code or publish unverified Critical/Warning findings. Persist a complete `review` artifact via `ima_lifecycle` and stop. Do not invoke `/ima:cycle` or automatic progression.
