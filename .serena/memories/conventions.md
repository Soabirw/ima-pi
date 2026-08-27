# Conventions

- Simple over complex; native Pi primitives before custom frameworks; evidence over assumptions.
- Use Node 24+, ESM, pure functions, explicit dependencies, and minimal self-documenting code.
- Use Pi package conventions and colon-namespaced user commands such as `/ima:plan` when proven by current Pi behavior.
- Preserve project-local -> user-local -> package precedence for IMA agent definitions; do not alter Pi native resource resolution.
- Do not build cycle automation, a workflow DSL, telemetry, or broad permission systems before evidence requires them.
- For task work, recall formal lifecycle artifacts through exact Tier-1 Qdrant manifest lookup plus selected direct detail fetch; Vestige is preferences-only and never a lifecycle fallback.
- Choose the smallest repository-supported test level that proves behavior; do not invent unsupported integration/E2E infrastructure.
- Initial review must be fresh and independent; routine implementation may use bounded autonomous delegation once implemented.