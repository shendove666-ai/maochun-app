const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../sync-core.js');

function emptyState() {
  return { records: {}, audits: {}, redemptions: [], customTasks: [] };
}

test('different people updating the same task do not overwrite each other', () => {
  const state = emptyState();
  core.applyOperation(state, {
    type: 'task_delta',
    payload: { day: '2026-10-31', task_id: 'meal', person: 'chun', delta: 1, owner: 'both' }
  });
  core.applyOperation(state, {
    type: 'task_delta',
    payload: { day: '2026-10-31', task_id: 'meal', person: 'mao', delta: 1, owner: 'both' }
  });
  assert.deepEqual(state.records['2026-10']['31'].meal, {
    chunCount: 1,
    maoCount: 1,
    stealBy: null,
    updatedAt: state.records['2026-10']['31'].meal.updatedAt
  });
});

test('exclusive task records a steal without leaving stale owner points', () => {
  const state = emptyState();
  core.applyOperation(state, {
    type: 'task_delta',
    payload: { day: '2026-11-01', task_id: 'dishes', person: 'chun', delta: 1, owner: 'chun', max_count: 1 }
  });
  core.applyOperation(state, {
    type: 'task_delta',
    payload: { day: '2026-11-01', task_id: 'dishes', person: 'mao', delta: 1, owner: 'chun', max_count: 1 }
  });
  const record = state.records['2026-11']['1'].dishes;
  assert.equal(record.chunCount, 0);
  assert.equal(record.maoCount, 1);
  assert.equal(record.stealBy, 'mao');
});

test('clear day and audit reversal propagate as explicit operations', () => {
  const state = emptyState();
  core.applyOperation(state, {
    type: 'task_delta',
    payload: { day: '2026-11-02', task_id: 'pet', person: 'mao', delta: 1, owner: 'mao' }
  });
  core.applyOperation(state, {
    type: 'audit_set',
    payload: { day: '2026-11-02', subject: 'mao', approved: true }
  });
  core.applyOperation(state, {
    type: 'audit_set',
    payload: { day: '2026-11-02', subject: 'mao', approved: false }
  });
  core.applyOperation(state, { type: 'clear_day', payload: { day: '2026-11-02' } });
  assert.equal(state.records['2026-11']['2'], undefined);
  assert.equal(state.audits['2026-11']['2'].maoAuditedByChun, false);
});

test('pending offline operations overlay the canonical server snapshot', () => {
  const snapshot = emptyState();
  const result = core.overlayPending(snapshot, [{
    type: 'redemption_create',
    payload: {
      redemption_id: '11111111-1111-4111-8111-111111111111',
      person: 'chun', item_name: '电影', points: 50, redeemed_on: '2026-11-03'
    }
  }]);
  assert.equal(result.redemptions.length, 1);
  assert.equal(result.redemptions[0].pts, 50);
});

test('snapshot migration emits all important entity types', () => {
  const snapshot = {
    records: { '2026-11': { 3: { t1: { chunCount: 2, maoCount: 0, stealBy: null } } } },
    audits: { '2026-11': { 3: { chunAuditedByMao: true, maoAuditedByChun: false } } },
    redemptions: [{ id: '22222222-2222-4222-8222-222222222222', who: 'mao', itemName: '花茶', pts: 45, dateStr: '2026-11-03' }],
    customTasks: [{ id: 'custom_1', name: '散步' }]
  };
  let sequence = 0;
  const operations = core.snapshotToOperations(snapshot, () => `id-${++sequence}`);
  assert.deepEqual(operations.map((operation) => operation.type), [
    'task_upsert', 'audit_set', 'redemption_create', 'custom_task_upsert'
  ]);
  assert.equal(operations[0].payload.points_per_unit, 1);
});

test('task point value travels with local deltas and snapshot migration', () => {
  const state = emptyState();
  core.applyOperation(state, {
    type: 'task_delta',
    payload: {
      day: '2026-11-04', task_id: 'dishes', person: 'chun', delta: 1,
      owner: 'chun', max_count: 1, points_per_unit: 7
    }
  });
  assert.equal(state.records['2026-11']['4'].dishes.pointsPerUnit, 7);

  const operations = core.snapshotToOperations(state, () => 'op-id', () => 3);
  assert.equal(operations[0].payload.points_per_unit, 7);
});
