import assert from "node:assert/strict";
import test from "node:test";
import * as artifactApi from "../lib/plane-taskwarrior-migration-artifacts.ts";
import { migrationPlanSha256 } from "../lib/plane-taskwarrior-migration.ts";
import {
  PreparedMigrationError,
  applyPreparedMigration,
  readPreparedMigrationStatus,
  reconcilePreparedMigration,
} from "../lib/plane-taskwarrior-prepared-run.ts";
import {
  applyInput,
  historicalPreparedData,
  migrationClient,
  preparedData,
  preparedRun,
  TASK_A,
} from "./plane-taskwarrior-prepared-run-fixtures.js";

const assertReadinessReportInvalid = async (prepared) => {
  await assert.rejects(
    readPreparedMigrationStatus({
      cwd: prepared.root,
      relativeRunPath: prepared.run.relativeRunPath,
      artifactApi,
    }),
    (error) => error instanceof PreparedMigrationError && error.code === "READINESS_REPORT_INVALID",
  );
};

const replaceReadinessReport = ({ prepared, report }) => artifactApi.replaceRunArtifact({
  run: prepared.run,
  name: artifactApi.MIGRATION_ARTIFACTS.preflightReport,
  value: report,
});

test("reads prepared status from local artifacts without Plane configuration", async (t) => {
  const prepared = await preparedRun(t);

  const status = await readPreparedMigrationStatus({
    cwd: prepared.root,
    relativeRunPath: prepared.run.relativeRunPath,
    artifactApi,
  });

  assert.deepEqual(status.state, "prepared");
  assert.equal(status.readiness, "READY");
  assert.equal(status.planSha256, prepared.plan.planSha256);
});

test("preserves a historical schema-v2 plan and payload during status, apply, and reconcile", async (t) => {
  const historical = historicalPreparedData();
  const prepared = await preparedRun(t, historical);
  const historicalDescriptions = historical.plan.items
    .filter((item) => item.disposition === "create")
    .map((item) => item.workItem.descriptionStripped);
  const expectedFirstDescription = [
    `Task ${TASK_A}`,
    "",
    "--- Taskwarrior provenance ---",
    `Taskwarrior UUID: ${TASK_A}`,
    "entry: 2026-09-01T00:00:00.000Z",
    "modified: 2026-09-02T00:00:00.000Z",
    "end: none",
  ].join("\n");

  const status = await readPreparedMigrationStatus({
    cwd: prepared.root,
    relativeRunPath: prepared.run.relativeRunPath,
    artifactApi,
  });
  assert.equal(status.planSha256, historical.plan.planSha256);
  assert.equal(historicalDescriptions[0], expectedFirstDescription);

  const fake = migrationClient();
  const applied = await applyPreparedMigration(applyInput({ prepared, client: fake.client }));
  assert.equal(applied.state, "applied");
  assert.deepEqual(
    fake.createdWorkItemInputs().map((input) => input.descriptionStripped),
    historicalDescriptions,
  );

  const reconciled = await reconcilePreparedMigration({
    cwd: prepared.root,
    relativeRunPath: prepared.run.relativeRunPath,
    env: {},
    artifactApi,
    createClient: () => fake.client,
    readConfig: () => ({}),
  });
  assert.equal(reconciled.state, "reconciled");

  const persistedPlan = await artifactApi.readRunArtifact({
    run: prepared.run,
    name: artifactApi.MIGRATION_ARTIFACTS.plan,
  });
  assert.deepEqual(
    persistedPlan.items
      .filter((item) => item.disposition === "create")
      .map((item) => item.workItem.descriptionStripped),
    historicalDescriptions,
  );
});

test("classifies an existing incomplete checkpoint as partially applied", async (t) => {
  const prepared = await preparedRun(t);
  await artifactApi.writeCheckpoint({
    run: prepared.run,
    value: {
      schemaVersion: 1,
      planSha256: prepared.plan.planSha256,
      planeItemIdsByTaskUuid: {},
      itemOutcomesByTaskUuid: {},
      relationOutcomesByKey: {},
      unresolvedRelationAttempts: [],
    },
  });

  const status = await readPreparedMigrationStatus({
    cwd: prepared.root,
    relativeRunPath: prepared.run.relativeRunPath,
    artifactApi,
  });
  assert.equal(status.state, "partially-applied");
});

test("rejects source-plan tampering before configuration or Plane access", async (t) => {
  const tampering = [
    {
      name: "name",
      expectedCode: "PREPARED_PLAN_SOURCE_MISMATCH",
      apply: async (prepared) => {
        const changedPlan = structuredClone(prepared.plan);
        changedPlan.items[0].workItem.name = "Changed after preparation";
        changedPlan.planSha256 = migrationPlanSha256(changedPlan);
        await artifactApi.replaceRunArtifact({
          run: prepared.run,
          name: artifactApi.MIGRATION_ARTIFACTS.plan,
          value: changedPlan,
        });
      },
    },
    {
      name: "description",
      expectedCode: "PREPARED_PLAN_SOURCE_MISMATCH",
      apply: async (prepared) => {
        const changedPlan = structuredClone(prepared.plan);
        changedPlan.items[0].workItem.descriptionStripped = "Changed description";
        changedPlan.planSha256 = migrationPlanSha256(changedPlan);
        await artifactApi.replaceRunArtifact({
          run: prepared.run,
          name: artifactApi.MIGRATION_ARTIFACTS.plan,
          value: changedPlan,
        });
      },
    },
    {
      name: "source task",
      expectedCode: "PREPARED_PLAN_SOURCE_MISMATCH",
      apply: async (prepared) => artifactApi.replaceRunArtifact({
        run: prepared.run,
        name: artifactApi.MIGRATION_ARTIFACTS.source,
        value: preparedData({ taskDescription: "Changed source task" }).source,
      }),
    },
    {
      name: "hash",
      expectedCode: "PREPARED_PLAN_INVALID",
      apply: async (prepared) => {
        const changedPlan = structuredClone(prepared.plan);
        const replacementCharacter = changedPlan.planSha256[0] === "0" ? "1" : "0";
        changedPlan.planSha256 = `${replacementCharacter}${changedPlan.planSha256.slice(1)}`;
        await artifactApi.replaceRunArtifact({
          run: prepared.run,
          name: artifactApi.MIGRATION_ARTIFACTS.plan,
          value: changedPlan,
        });
      },
    },
  ];

  for (const tamper of tampering) {
    const prepared = await preparedRun(t);
    await tamper.apply(prepared);
    let configCalls = 0;
    let clientCalls = 0;

    await assert.rejects(
      applyPreparedMigration({
        ...applyInput({ prepared, client: {} }),
        createClient: () => { clientCalls += 1; return {}; },
        readConfig: () => { configCalls += 1; return {}; },
      }),
      (error) => error instanceof PreparedMigrationError && error.code === tamper.expectedCode,
      tamper.name,
    );
    assert.equal(configCalls, 0, tamper.name);
    assert.equal(clientCalls, 0, tamper.name);
  }
});

test("revalidates the reviewed hash under the migration lock before configuration", async (t) => {
  const prepared = await preparedRun(t);
  const replacement = preparedData({ taskDescription: "Changed under lock" });
  let configCalls = 0;
  const artifact = {
    ...artifactApi,
    withMigrationLock: async ({ run, operation }) => {
      await artifactApi.replaceRunArtifact({
        run,
        name: artifactApi.MIGRATION_ARTIFACTS.source,
        value: replacement.source,
      });
      await artifactApi.replaceRunArtifact({
        run,
        name: artifactApi.MIGRATION_ARTIFACTS.plan,
        value: replacement.plan,
      });
      return artifactApi.withMigrationLock({ run, operation });
    },
  };

  await assert.rejects(
    applyPreparedMigration({
      ...applyInput({ prepared, client: migrationClient().client, artifact }),
      readConfig: () => { configCalls += 1; return {}; },
    }),
    (error) => error instanceof PreparedMigrationError && error.code === "PLAN_HASH_CHANGED",
  );
  assert.equal(configCalls, 0);
});

test("applies idempotently, then reconciles through read-only observation", async (t) => {
  const prepared = await preparedRun(t);
  const fake = migrationClient();

  const first = await applyPreparedMigration(applyInput({ prepared, client: fake.client }));
  assert.equal(first.state, "applied");
  assert.deepEqual(fake.stats(), {
    createdItems: 2,
    createdRelations: 1,
    stateReads: 1,
    identityReads: 4,
  });

  const second = await applyPreparedMigration(applyInput({ prepared, client: fake.client }));
  assert.equal(second.state, "applied");
  assert.deepEqual(fake.stats(), {
    createdItems: 2,
    createdRelations: 1,
    stateReads: 2,
    identityReads: 8,
  });

  const appliedStatus = await readPreparedMigrationStatus({
    cwd: prepared.root,
    relativeRunPath: prepared.run.relativeRunPath,
    artifactApi,
  });
  assert.equal(appliedStatus.state, "applied");

  const reconciled = await reconcilePreparedMigration({
    cwd: prepared.root,
    relativeRunPath: prepared.run.relativeRunPath,
    env: {},
    artifactApi,
    createClient: () => fake.client,
    readConfig: () => ({}),
  });
  assert.equal(reconciled.state, "reconciled");
  assert.deepEqual(fake.stats(), {
    createdItems: 2,
    createdRelations: 1,
    stateReads: 2,
    identityReads: 10,
  });

  const reconciledStatus = await readPreparedMigrationStatus({
    cwd: prepared.root,
    relativeRunPath: prepared.run.relativeRunPath,
    artifactApi,
  });
  assert.equal(reconciledStatus.state, "reconciled");
});

test("invalidates prior reconciliation evidence before a later partial apply", async (t) => {
  const prepared = await preparedRun(t);
  const fake = migrationClient();
  await applyPreparedMigration(applyInput({ prepared, client: fake.client }));
  await reconcilePreparedMigration({
    cwd: prepared.root,
    relativeRunPath: prepared.run.relativeRunPath,
    env: {},
    artifactApi,
    createClient: () => fake.client,
    readConfig: () => ({}),
  });
  assert.equal((await readPreparedMigrationStatus({
    cwd: prepared.root,
    relativeRunPath: prepared.run.relativeRunPath,
    artifactApi,
  })).state, "reconciled");

  fake.failNextRelationLookup();
  const reapplied = await applyPreparedMigration(applyInput({ prepared, client: fake.client }));
  assert.equal(reapplied.state, "partially-applied");
  assert.equal((await readPreparedMigrationStatus({
    cwd: prepared.root,
    relativeRunPath: prepared.run.relativeRunPath,
    artifactApi,
  })).state, "partially-applied");
  await assert.rejects(artifactApi.readRunArtifact({
    run: prepared.run,
    name: artifactApi.MIGRATION_ARTIFACTS.reconciliationReport,
  }), /ENOENT/);
});

test("blocks prepared apply before Plane creates when reconciliation invalidation fails", async (t) => {
  const prepared = await preparedRun(t);
  const fake = migrationClient();
  const failingArtifacts = {
    ...artifactApi,
    clearReconciliationReport: async () => { throw new Error("synthetic invalidation failure"); },
  };

  await assert.rejects(
    applyPreparedMigration(applyInput({
      prepared,
      client: fake.client,
      artifact: failingArtifacts,
    })),
    (error) => error instanceof PreparedMigrationError && error.code === "RECONCILIATION_INVALIDATION_FAILED",
  );
  assert.deepEqual(fake.stats(), {
    createdItems: 0,
    createdRelations: 0,
    stateReads: 1,
    identityReads: 2,
  });
});

test("rejects malformed reconciliation reports before local status can verify completion", async (t) => {
  const prepared = await preparedRun(t);
  const fake = migrationClient();
  await applyPreparedMigration(applyInput({ prepared, client: fake.client }));
  await reconcilePreparedMigration({
    cwd: prepared.root,
    relativeRunPath: prepared.run.relativeRunPath,
    env: {},
    artifactApi,
    createClient: () => fake.client,
    readConfig: () => ({}),
  });
  const validReport = await artifactApi.readRunArtifact({
    run: prepared.run,
    name: artifactApi.MIGRATION_ARTIFACTS.reconciliationReport,
  });
  assert.equal((await readPreparedMigrationStatus({
    cwd: prepared.root,
    relativeRunPath: prepared.run.relativeRunPath,
    artifactApi,
  })).state, "reconciled");
  const relation = validReport.relations.find((entry) => entry.status === "matched");
  const variants = [
    ["schema", (report) => ({ ...report, schemaVersion: 2 })],
    ["summary", (report) => ({
      ...report,
      summary: { ...report.summary, task: { ...report.summary.task, matched: 0 } },
    })],
    ["item evidence", (report) => ({
      ...report,
      items: report.items.map((item, index) => index === 0 ? { ...item, planeItemId: "not-a-uuid" } : item),
    })],
    ["duplicate item", (report) => ({ ...report, items: [...report.items, report.items[0]] })],
    ["unknown relation", (report) => ({
      ...report,
      relations: report.relations.map((entry, index) => index === 0
        ? { ...entry, sourceTaskUuid: "33333333-3333-4333-8333-333333333333" }
        : entry),
    })],
    ["unresolved count", (report) => ({
      ...report,
      unresolvedRelationAttempts: [{
        sourceTaskUuid: relation.sourceTaskUuid,
        targetTaskUuid: relation.targetTaskUuid,
        reason: "HTTP_ERROR",
      }],
    })],
  ];

  for (const [_name, mutate] of variants) {
    await artifactApi.replaceRunArtifact({
      run: prepared.run,
      name: artifactApi.MIGRATION_ARTIFACTS.reconciliationReport,
      value: mutate(JSON.parse(JSON.stringify(validReport))),
    });
    await assert.rejects(
      readPreparedMigrationStatus({
        cwd: prepared.root,
        relativeRunPath: prepared.run.relativeRunPath,
        artifactApi,
      }),
      (error) => error instanceof PreparedMigrationError && error.code === "RECONCILIATION_REPORT_INVALID",
    );
  }
});

test("derives nonmatching reconciliation state from checkpoint completeness", async (t) => {
  const incomplete = await preparedRun(t);
  await artifactApi.writeCheckpoint({
    run: incomplete.run,
    value: {
      schemaVersion: 1,
      planSha256: incomplete.plan.planSha256,
      planeItemIdsByTaskUuid: {},
      itemOutcomesByTaskUuid: {},
      relationOutcomesByKey: {},
      unresolvedRelationAttempts: [],
    },
  });
  const missingClient = {
    listProjectWorkItems: async () => [],
    listWorkItemRelations: async () => ({ blockedByIds: [] }),
  };
  const incompleteResult = await reconcilePreparedMigration({
    cwd: incomplete.root,
    relativeRunPath: incomplete.run.relativeRunPath,
    env: {},
    artifactApi,
    createClient: () => missingClient,
    readConfig: () => ({}),
  });
  assert.equal(incompleteResult.state, "partially-applied");
  assert.equal((await readPreparedMigrationStatus({
    cwd: incomplete.root,
    relativeRunPath: incomplete.run.relativeRunPath,
    artifactApi,
  })).state, "partially-applied");

  const complete = await preparedRun(t);
  const completeClient = migrationClient();
  await applyPreparedMigration(applyInput({ prepared: complete, client: completeClient.client }));
  const completeResult = await reconcilePreparedMigration({
    cwd: complete.root,
    relativeRunPath: complete.run.relativeRunPath,
    env: {},
    artifactApi,
    createClient: () => missingClient,
    readConfig: () => ({}),
  });
  assert.equal(completeResult.state, "applied");
  assert.equal((await readPreparedMigrationStatus({
    cwd: complete.root,
    relativeRunPath: complete.run.relativeRunPath,
    artifactApi,
  })).state, "applied");
});

test("accepts plan-bound schema 1 and schema 2 readiness reports", async (t) => {
  const prepared = await preparedRun(t);
  const schema1 = await artifactApi.readRunArtifact({
    run: prepared.run,
    name: artifactApi.MIGRATION_ARTIFACTS.preflightReport,
  });

  assert.equal((await readPreparedMigrationStatus({
    cwd: prepared.root,
    relativeRunPath: prepared.run.relativeRunPath,
    artifactApi,
  })).readiness, "READY");

  await replaceReadinessReport({
    prepared,
    report: { ...schema1, schemaVersion: 2 },
  });
  assert.equal((await readPreparedMigrationStatus({
    cwd: prepared.root,
    relativeRunPath: prepared.run.relativeRunPath,
    artifactApi,
  })).readiness, "READY");

  await replaceReadinessReport({
    prepared,
    report: {
      ...schema1,
      outcome: "BLOCKED",
      destinations: [{
        ...schema1.destinations[0],
        capabilities: schema1.destinations[0].capabilities.map((entry) =>
          entry.capability === "project_states" ? { ...entry, status: "BLOCKED" } : entry),
      }],
    },
  });
  const blockedStatus = await readPreparedMigrationStatus({
    cwd: prepared.root,
    relativeRunPath: prepared.run.relativeRunPath,
    artifactApi,
  });
  assert.equal(blockedStatus.state, "blocked");
  assert.equal(blockedStatus.readiness, "BLOCKED");
});

test("rejects readiness reports that are not exact and internally consistent", async (t) => {
  const prepared = await preparedRun(t);
  const validReport = await artifactApi.readRunArtifact({
    run: prepared.run,
    name: artifactApi.MIGRATION_ARTIFACTS.preflightReport,
  });
  const blockedCapabilities = validReport.destinations[0].capabilities.map((entry, index) =>
    index === 0 ? { ...entry, status: "BLOCKED", reason: "SYNTHETIC" } : entry);
  const malformedStatusVariants = [
    ["project_states", "UNVERIFIED_WRITE"],
    ["external_identity_lookup", "UNVERIFIED_WRITE"],
    ["work_item_creation", "READY"],
    ["work_item_creation", "BLOCKED"],
    ["work_item_relations", "READY"],
    ["work_item_relations", "BLOCKED"],
    ["relation_creation", "READY"],
    ["relation_creation", "BLOCKED"],
  ].map(([capability, status]) => [
    `${capability} cannot be ${status}`,
    (report) => ({
      ...report,
      destinations: [{
        ...report.destinations[0],
        capabilities: report.destinations[0].capabilities.map((entry) =>
          entry.capability === capability ? { ...entry, status } : entry),
      }],
    }),
  ]);
  const variants = [
    ["substituted destination", (report) => ({
      ...report,
      destinations: [{ ...report.destinations[0], projectKey: "OTHER" }],
    })],
    ["omitted destination", (report) => ({ ...report, destinations: [] })],
    ["extra destination", (report) => ({
      ...report,
      destinations: [...report.destinations, { ...report.destinations[0], projectKey: "EXTRA" }],
    })],
    ["duplicate capability", (report) => ({
      ...report,
      destinations: [{
        ...report.destinations[0],
        capabilities: [...report.destinations[0].capabilities, report.destinations[0].capabilities[0]],
      }],
    })],
    ["unknown capability", (report) => ({
      ...report,
      destinations: [{
        ...report.destinations[0],
        capabilities: report.destinations[0].capabilities.map((entry, index) =>
          index === 0 ? { ...entry, capability: "unknown" } : entry),
      }],
    })],
    ["declared ready with blocked capability", (report) => ({
      ...report,
      outcome: "READY",
      destinations: [{ ...report.destinations[0], capabilities: blockedCapabilities }],
    })],
    ["declared blocked without blocked capability", (report) => ({ ...report, outcome: "BLOCKED" })],
    ...malformedStatusVariants,
  ];

  for (const [_name, mutate] of variants) {
    await replaceReadinessReport({
      prepared,
      report: mutate(JSON.parse(JSON.stringify(validReport))),
    });
    await assertReadinessReportInvalid(prepared);
  }
});
