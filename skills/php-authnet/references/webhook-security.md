# Authorize.Net webhook security

Use this reference for a production webhook handler. It complements the raw-body HMAC-SHA512 and
`hash_equals()` example in [api-reference.md](api-reference.md); signature verification authenticates
a delivery, while idempotency protects the effect that follows it.

## Delivery contract

Authorize.Net webhook deliveries can be retried. Treat a verified `notificationId` as the provider
identity for one notification, not as a short-lived cache key. Verify the signature against the raw
body before parsing or performing any effect, then validate that the expected notification fields are
present and have the required shape.

Acknowledge a delivery only after the system has durably recorded the state needed to recover it.
Do not let a `get_transient()` followed by `set_transient()` decide whether to run a payment,
subscription, fulfillment, or other external effect. That read-then-write sequence is
legacy/non-production guidance: it is neither atomic under concurrency nor durable across later
replays.

## Durable atomic notification identity

Persist one durable notification record keyed by a provider namespace and `notificationId`. The
storage constraint—not an in-process lock or expiring cache—must enforce uniqueness, for example a
unique `(provider, notification_id)` key. Its atomic claim operation must allow only one delivery to
move a notification into effect processing.

Keep an explicit state such as `claimed`, `committed`, or `retryable` with the identity. A row that is
already `committed` makes a later replay a no-op. A concurrent delivery that cannot claim the row
must not run the effect. If the system cannot determine a safe outcome, it must leave recoverable
state and follow the provider's retry or worker-recovery policy rather than guessing.

```text
claim = notificationStore.claimAtomically({
  provider: "authorize-net",
  notificationId,
})

if (claim.status === "committed") return noOp
if (claim.status !== "claimed") return withoutRunningTheEffect

try {
  applyEffect({ idempotencyKey: notificationId })
  notificationStore.commit(claim)
} catch {
  notificationStore.markRetryable(claim)
  throw retryableFailure
}
```

`claimAtomically()` is a storage boundary: implement it with a durable unique constraint and a single
transactional insert/transition or equivalent atomic datastore primitive. Do not model it as a read
followed by a separate write.

## Effect and retry boundaries

A local unique record alone does not make an external effect exactly once. A crash after an external
payment or fulfillment succeeds but before `commit()` can cause a retry. Where the downstream system
supports an idempotency key, send the same `notificationId`; otherwise use a transactional outbox or
another documented recovery boundary that can reconcile the effect before a retry.

- A verified delivery that already has a committed record is acknowledged without repeating the
  effect.
- A failed effect stays durable and retryable. Do not erase the notification record just to retry it.
- A worker or subsequent delivery may safely reclaim only a documented retryable/stale claim under
  the same atomic transition rules.
- Invalid signatures, malformed identities, or unverifiable state fail closed and never reach the
  effect.
- Keep raw payloads, signature keys, authorization data, and internal diagnostics out of public
  responses and shared logs.

## Review and test cases

Document or test the actual persistence boundary, not just the presence of a `notificationId` field:

1. Two concurrent deliveries with the same identity result in one effect.
2. A later delivery after `committed` is a no-op.
3. A failed effect becomes retryable without losing the durable identity.
4. A downstream effect receives the same identity when it supports idempotency.
5. An invalid HMAC or malformed `notificationId` reaches no claim or effect.

## Provider references

- [Authorize.Net Webhooks: retries, notification history, and signature verification](https://developer.authorize.net/api/reference/features/webhooks.html)
- [IMA security guardrails](../../ima-security-guardrails/SKILL.md)
