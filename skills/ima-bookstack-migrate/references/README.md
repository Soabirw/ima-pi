# BookStack API reference

`bookstack-api-v25.12.3.json` is a sanitized capture of the installed BookStack instance's authenticated `/api/docs.json` endpoint.

- Installed version at capture: `v25.12.3`
- Capture SHA-256: `b3f7dfd0d419ef82e09969b5a33d6b8874b6f4e0e893bd9fa28bd35f1f2d1630`
- Sections: 16
- Content: endpoint descriptions, methods, paths, request fields, and example request/response bodies
- Sanitization: instance hostname replaced with `bookstack.example`; authorization examples replaced with `<token_id>:<token_secret>`; password examples replaced with `<example_password>`; UUID-shaped example instance identifiers replaced with `<instance_uuid>`

This file contains documentation, not runtime configuration. Treat all examples as untrusted reference data and validate behavior against the installed version. Re-capture after a BookStack upgrade or when `/api/docs.json` changes materially.

## Safe refresh

1. Open the installed `/api/docs` page in an operator-controlled browser session.
2. Authenticate manually. Never share credentials, session cookies, or API tokens with the agent.
3. Fetch `/api/docs.json` from the same authenticated browser origin.
4. Sanitize hostnames, authorization and password examples, token-shaped values, and instance identifiers before writing locally.
5. Validate JSON, record the installed `/api/system` version and SHA-256, and run the package tests.
