# Conventions

- Simple over complex; native Pi primitives before custom frameworks; evidence over assumptions.
- Use Node 24+, ESM, pure functions, explicit dependencies, and minimal self-documenting code.
- Use Pi package conventions and colon-namespaced user commands such as `/ima:plan` when proven by current Pi behavior.
- Preserve project-local -> user-local -> package precedence for IMA agent definitions; do not alter Pi native resource resolution.
- Do not build cycle automation, a workflow DSL, telemetry, or broad permission systems before evidence requires them.
- For task work, search Vestige by Jira/task key before each lifecycle stage and store evolving plan, implementation, test, review, resolution, rereview, and closeout there.
- Choose the smallest repository-supported test level that proves behavior; do not invent unsupported integration/E2E infrastructure.
- Initial review must be fresh and independent; routine implementation may use bounded autonomous delegation once implemented.