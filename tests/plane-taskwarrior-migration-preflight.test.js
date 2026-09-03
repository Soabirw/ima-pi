import assert from "node:assert/strict";
import test from "node:test";
import { buildMigrationPlan } from "../lib/plane-taskwarrior-migration.ts";
import {
  MigrationPreflightError,
  exactIdentityMatches,
  oneIdentityMatch,
  runMigrationPreflight,
} from "../lib/plane-taskwarrior-migration-preflight.ts";
import { MIGRATION_DESTINATIONS } from "../scripts/plane-taskwarrior-migrate.mjs";
import { migrationFixture } from "./plane-taskwarrior-migration-fixtures.js";

const planFromFixture = () => buildMigrationPlan(migrationFixture());

const destinationForProject = (projectId) => Object.entries(MIGRATION_DESTINATIONS)
  .map(([projectKey, destination]) => ({ projectKey, ...destination }))
  .find((destination) => destination.projectId === projectId) ?? null;

const destinationForRepresentative = (reference) => Object.entries(MIGRATION_DESTINATIONS)
  .map(([projectKey, destination]) => ({ projectKey, ...destination }))
  .find((destination) => destination.representativeReference === reference) ?? null;

const statesFor = (destination) => [
  { id: destination.backlogStateId, group: "backlog" },
  { id: destination.doneStateId, group: "completed" },
];

const preflightClient = ({
  getWorkItem = (destination) => ({ id: destination.projectId, projectId: destination.projectId }),
  listProjectStates = (destination) => statesFor(destination),
  listWorkItemRelations = () => ({ blockedByIds: [] }),
  listProjectWorkItems = () => [],
} = {}) => {
  let mutationCalls = 0;
  const client = {
    getWorkItem: async (reference) => {
      const destination = destinationForRepresentative(reference);
      if (!destination) throw new Error("unexpected representative reference");
      return getWorkItem(destination);
    },
    listProjectStates: async ({ projectId }) => {
      const destination = destinationForProject(projectId);
      if (!destination) throw new Error("unexpected project state read");
      return listProjectStates(destination);
    },
    listWorkItemRelations: async (scope) => listWorkItemRelations(scope),
    listProjectWorkItems: async (lookup) => listProjectWorkItems(lookup),
    createProjectWorkItem: async () => {
      mutationCalls += 1;
      throw new Error("mutation must not be called");
    },
    createWorkItemRelation: async () => {
      mutationCalls += 1;
      throw new Error("mutation must not be called");
    },
  };

  return { client, mutationCalls: () => mutationCalls };
};

const capabilityFor = (report, projectKey, name) => report.destinations
  .find((destination) => destination.projectKey === projectKey)
  .capabilities.find((entry) => entry.capability === name);

test("keeps representative references outside the migration plan and its hash", () => {
  const fixture = migrationFixture();
  const originalPlan = buildMigrationPlan(fixture);
  const preflightPlan = buildMigrationPlan({
    ...fixture,
    destinations: MIGRATION_DESTINATIONS,
  });

  assert.equal(preflightPlan.planSha256, originalPlan.planSha256);
  assert.equal(JSON.stringify(preflightPlan).includes("representativeReference"), false);
});

test("runs every approved read capability and reports write-only uncertainty without mutation", async () => {
  const plan = planFromFixture();
  const fake = preflightClient();

  const report = await runMigrationPreflight({
    client: fake.client,
    plan,
    destinations: MIGRATION_DESTINATIONS,
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.planSha256, plan.planSha256);
  assert.equal(report.outcome, "READY");
  assert.equal(report.destinations.length, 2);
  assert.deepEqual(
    report.destinations.flatMap((destination) => destination.capabilities.map((entry) => entry.capability)),
    [
      "representative_work_item",
      "project_states",
      "work_item_relations",
      "external_identity_lookup",
      "work_item_creation",
      "relation_creation",
      "representative_work_item",
      "project_states",
      "work_item_relations",
      "external_identity_lookup",
      "work_item_creation",
      "relation_creation",
    ],
  );
  assert.deepEqual(capabilityFor(report, "WEB", "external_identity_lookup"), {
    capability: "external_identity_lookup",
    status: "READY",
    identityMatchCount: 0,
  });
  assert.deepEqual(capabilityFor(report, "SKYNET", "work_item_creation"), {
    capability: "work_item_creation",
    status: "UNVERIFIED_WRITE",
    reason: "WRITE_ONLY",
  });
  assert.equal(fake.mutationCalls(), 0);
  assert.equal(/api.?key|authorization|headers?|base.?url|response|exception|stack|"error"/i.test(JSON.stringify(report)), false);
});

test("reports bounded, capability-specific failures without external error text", async () => {
  const plan = planFromFixture();
  const otherProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const scenarios = [
    {
      name: "representative read",
      client: preflightClient({
        getWorkItem: () => { throw new Error("synthetic representative secret"); },
      }),
      capability: "representative_work_item",
      reason: "REPRESENTATIVE_READ_FAILED",
    },
    {
      name: "representative project mismatch",
      client: preflightClient({
        getWorkItem: (destination) => ({ id: destination.projectId, projectId: otherProjectId }),
      }),
      capability: "representative_work_item",
      reason: "REPRESENTATIVE_PROJECT_MISMATCH",
    },
    {
      name: "configured state group",
      client: preflightClient({
        listProjectStates: (destination) => [
          { id: destination.backlogStateId, group: "started" },
          { id: destination.doneStateId, group: "completed" },
        ],
      }),
      capability: "project_states",
      reason: "BACKLOG_STATE_GROUP_INVALID",
    },
    {
      name: "relation shape",
      client: preflightClient({ listWorkItemRelations: () => ({}) }),
      capability: "work_item_relations",
      reason: "RELATION_LIST_INVALID",
    },
    {
      name: "identity ambiguity",
      client: preflightClient({
        listProjectWorkItems: ({ externalId, externalSource }) => [
          {
            id: "11111111-1111-4111-8111-111111111111",
            externalId,
            externalSource,
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            externalId,
            externalSource,
          },
        ],
      }),
      capability: "external_identity_lookup",
      reason: "IDENTITY_AMBIGUOUS",
    },
  ];

  for (const scenario of scenarios) {
    const report = await runMigrationPreflight({
      client: scenario.client.client,
      plan,
      destinations: MIGRATION_DESTINATIONS,
    });
    const result = capabilityFor(report, "WEB", scenario.capability);

    assert.equal(report.outcome, "BLOCKED", scenario.name);
    assert.equal(result.status, "BLOCKED", scenario.name);
    assert.equal(result.reason, scenario.reason, scenario.name);
    assert.equal(JSON.stringify(report).includes("synthetic representative secret"), false, scenario.name);
    assert.equal(scenario.client.mutationCalls(), 0, scenario.name);
  }
});

test("keeps identity cardinality validation pure and fail-closed", () => {
  const plan = planFromFixture();
  const item = plan.items.find((entry) => entry.disposition === "create");
  const matchingWorkItem = {
    id: "11111111-1111-4111-8111-111111111111",
    externalId: item.workItem.externalId,
    externalSource: item.workItem.externalSource,
  };

  assert.deepEqual(exactIdentityMatches({ workItems: [], item }), []);
  assert.equal(oneIdentityMatch({ workItems: [matchingWorkItem], item }).id, matchingWorkItem.id);
  assert.throws(
    () => oneIdentityMatch({ workItems: [matchingWorkItem, { ...matchingWorkItem, id: "22222222-2222-4222-8222-222222222222" }], item }),
    (error) => error instanceof MigrationPreflightError && error.code === "IDENTITY_AMBIGUOUS",
  );
  assert.throws(
    () => exactIdentityMatches({ workItems: [{ id: "not-a-uuid" }], item }),
    (error) => error instanceof MigrationPreflightError && error.code === "IDENTITY_LOOKUP_INVALID",
  );
});
