import assert from "node:assert/strict";
import test from "node:test";
import { createBookStackClient } from "../lib/bookstack-migrate-client.ts";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("uses a fixed HTTPS origin, token auth, JSON, and redirect denial", async () => {
  const calls = [];
  const client = createBookStackClient({
    origin: "https://bookstack.example", tokenId: "id", tokenSecret: "secret",
    fetch: async (url, options) => { calls.push({ url: String(url), options }); return json({ data: [{ id: 7, name: "Lifecycle Artifacts" }] }); },
  });
  assert.deepEqual(await client.listShelves(), [{ id: 7, name: "Lifecycle Artifacts" }]);
  assert.equal(calls[0].url, "https://bookstack.example/api/shelves?count=500&offset=0");
  assert.equal(calls[0].options.headers.authorization, "Token id:secret");
  assert.equal(calls[0].options.redirect, "error");
  assert.throws(() => createBookStackClient({ origin: "http://bookstack.example", tokenId: "id", tokenSecret: "secret" }), /bookstack_origin_invalid/);
  assert.throws(() => createBookStackClient({ origin: "https://id:secret@bookstack.example", tokenId: "id", tokenSecret: "secret" }), /bookstack_origin_invalid/);
});

test("rejects ambiguous shelf names and malformed API bodies", async () => {
  const client = createBookStackClient({ origin: "https://bookstack.example", tokenId: "id", tokenSecret: "secret", fetch: async () => json({ data: [{ id: 1, name: "x" }, { id: 2, name: "x" }] }) });
  await assert.rejects(client.resolveShelf("x"), /bookstack_identity_ambiguous/);
});
