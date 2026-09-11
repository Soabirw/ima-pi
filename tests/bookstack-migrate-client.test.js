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

test("distinguishes absent and ambiguous shelf names", async () => {
  const ambiguous = createBookStackClient({ origin: "https://bookstack.example", tokenId: "id", tokenSecret: "secret", fetch: async () => json({ data: [{ id: 1, name: "x" }, { id: 2, name: "x" }] }) });
  await assert.rejects(ambiguous.resolveShelf("x"), /bookstack_identity_ambiguous/);
  const absent = createBookStackClient({ origin: "https://bookstack.example", tokenId: "id", tokenSecret: "secret", fetch: async () => json({ data: [] }) });
  await assert.rejects(absent.resolveShelf("x"), /bookstack_shelf_absent/);
});

test("updates Shelf membership then verifies it through an explicit read-back", async () => {
  const calls = [];
  const client = createBookStackClient({
    origin: "https://bookstack.example",
    tokenId: "id",
    tokenSecret: "secret",
    fetch: async (_url, options = {}) => {
      calls.push(options.method ?? "GET");
      if (options.method === "PUT") return json({ id: 7, name: "Lifecycle Artifacts" });
      return json({ id: 7, name: "Lifecycle Artifacts", books: [{ id: 3 }, { id: 5 }] });
    },
  });
  await client.replaceShelfBooks(7, "Lifecycle Artifacts", [3, 5]);
  assert.deepEqual(calls, ["PUT", "GET"]);
});

test("maps request cancellation to a bounded transport failure", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = createBookStackClient({
    origin: "https://bookstack.example",
    tokenId: "id",
    tokenSecret: "secret",
    signal: controller.signal,
    fetch: async (_url, options) => {
      options.signal.throwIfAborted();
      return json({ data: [] });
    },
  });
  await assert.rejects(client.listShelves(), /bookstack_transport_failed/);
});

test("accepts the empty success response used by Page deletion", async () => {
  const calls = [];
  const client = createBookStackClient({
    origin: "https://bookstack.example",
    tokenId: "id",
    tokenSecret: "secret",
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(null, { status: 204 });
    },
  });
  await client.deletePage(42);
  assert.equal(calls[0].options.method, "DELETE");
});
