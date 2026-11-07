(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MaoChunCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function safeInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : fallback;
  }

  function parseDay(dateValue) {
    const match = /^(\d{4}-\d{2})-(\d{2})$/.exec(String(dateValue || ''));
    if (!match) throw new Error('日期格式无效');
    const [year, month] = match[1].split('-').map(Number);
    const dayNumber = Number(match[2]);
    const date = new Date(Date.UTC(year, month - 1, dayNumber));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== dayNumber) {
      throw new Error('日期格式无效');
    }
    return { month: match[1], day: String(Number(match[2])) };
  }

  function ensureDomain(state) {
    if (!state.records || typeof state.records !== 'object') state.records = {};
    if (!state.audits || typeof state.audits !== 'object') state.audits = {};
    if (!Array.isArray(state.redemptions)) state.redemptions = [];
    if (!Array.isArray(state.customTasks)) state.customTasks = [];
    return state;
  }

  function ensureTaskRecord(state, date, taskId) {
    const { month, day } = parseDay(date);
    if (!state.records[month]) state.records[month] = {};
    if (!state.records[month][day]) state.records[month][day] = {};
    if (!state.records[month][day][taskId]) {
      state.records[month][day][taskId] = {
        chunCount: 0,
        maoCount: 0,
        stealBy: null
      };
    }
    return state.records[month][day][taskId];
  }

  function applyTaskDelta(state, payload, timestamp) {
    const person = payload.person === 'chun' ? 'chun' : payload.person === 'mao' ? 'mao' : null;
    if (!person) throw new Error('使用者无效');
    const owner = ['chun', 'mao', 'both'].includes(payload.owner) ? payload.owner : 'both';
    const taskId = String(payload.task_id || '').trim();
    if (!taskId) throw new Error('项目编号无效');

    const record = ensureTaskRecord(state, payload.day, taskId);
    const ownKey = person === 'chun' ? 'chunCount' : 'maoCount';
    const otherKey = person === 'chun' ? 'maoCount' : 'chunCount';
    const maxCount = payload.max_count == null ? null : Math.max(1, safeInteger(payload.max_count, 1));
    const nextCount = Math.max(0, safeInteger(record[ownKey]) + safeInteger(payload.delta));
    record[ownKey] = maxCount == null ? nextCount : Math.min(maxCount, nextCount);
    const pointsPerUnit = Math.max(0, Math.min(100000, safeInteger(payload.points_per_unit, safeInteger(record.pointsPerUnit))));
    if (pointsPerUnit > 0) record.pointsPerUnit = pointsPerUnit;

    if (owner !== 'both' && record[ownKey] > 0) {
      record[otherKey] = 0;
      record.stealBy = owner === person ? null : person;
    } else if (record[ownKey] === 0 && record.stealBy === person) {
      record.stealBy = null;
    } else if (owner === 'both') {
      record.stealBy = null;
    }
    record.updatedAt = timestamp;
  }

  function applyOperation(state, operation) {
    ensureDomain(state);
    if (!operation || !operation.type || !operation.payload) return state;
    const payload = operation.payload;
    const timestamp = operation.server_created_at || operation.client_created_at || new Date().toISOString();

    switch (operation.type) {
      case 'task_delta':
        applyTaskDelta(state, payload, timestamp);
        break;
      case 'task_upsert': {
        const record = ensureTaskRecord(state, payload.day, String(payload.task_id || ''));
        record.chunCount = Math.max(0, safeInteger(payload.chun_count));
        record.maoCount = Math.max(0, safeInteger(payload.mao_count));
        record.stealBy = ['chun', 'mao'].includes(payload.steal_by) ? payload.steal_by : null;
        const pointsPerUnit = Math.max(0, Math.min(100000, safeInteger(payload.points_per_unit)));
        if (pointsPerUnit > 0) record.pointsPerUnit = pointsPerUnit;
        record.updatedAt = timestamp;
        break;
      }
      case 'clear_day': {
        const { month, day } = parseDay(payload.day);
        if (state.records[month]) delete state.records[month][day];
        break;
      }
      case 'audit_set': {
        const { month, day } = parseDay(payload.day);
        if (!state.audits[month]) state.audits[month] = {};
        if (!state.audits[month][day]) {
          state.audits[month][day] = { chunAuditedByMao: false, maoAuditedByChun: false };
        }
        if (payload.subject === 'chun') {
          state.audits[month][day].chunAuditedByMao = Boolean(payload.approved);
        } else if (payload.subject === 'mao') {
          state.audits[month][day].maoAuditedByChun = Boolean(payload.approved);
        }
        break;
      }
      case 'redemption_create': {
        const id = String(payload.redemption_id || '');
        if (!id || state.redemptions.some((item) => item.id === id)) break;
        state.redemptions.unshift({
          id,
          dateStr: String(payload.redeemed_on || ''),
          who: payload.person === 'chun' ? 'chun' : 'mao',
          itemName: String(payload.item_name || '').slice(0, 100),
          pts: Math.max(1, safeInteger(payload.points, 1))
        });
        break;
      }
      case 'redemption_cancel':
        state.redemptions = state.redemptions.filter((item) => item.id !== payload.redemption_id);
        break;
      case 'custom_task_upsert': {
        const definition = payload.definition;
        if (!definition || typeof definition !== 'object' || !payload.task_id) break;
        state.customTasks = state.customTasks.filter((task) => task.id !== payload.task_id);
        state.customTasks.push({ ...definition, id: payload.task_id });
        break;
      }
      case 'custom_task_delete':
        state.customTasks = state.customTasks.filter((task) => task.id !== payload.task_id);
        break;
      case 'reset_all':
        state.records = {};
        state.audits = {};
        state.redemptions = [];
        state.customTasks = [];
        break;
      default:
        break;
    }
    return state;
  }

  function overlayPending(snapshot, pendingOperations) {
    const result = {
      records: structuredClone(snapshot.records || {}),
      audits: structuredClone(snapshot.audits || {}),
      redemptions: structuredClone(snapshot.redemptions || []),
      customTasks: structuredClone(snapshot.customTasks || [])
    };
    for (const operation of pendingOperations || []) applyOperation(result, operation);
    return result;
  }

  function snapshotToOperations(snapshot, createId, resolvePoints) {
    const operations = [];
    const nextId = typeof createId === 'function' ? createId : () => crypto.randomUUID();
    for (const [month, days] of Object.entries(snapshot.records || {})) {
      for (const [day, tasks] of Object.entries(days || {})) {
        for (const [taskId, record] of Object.entries(tasks || {})) {
          if (!(record.chunCount || record.maoCount || record.stealBy)) continue;
          const dateString = `${month}-${String(day).padStart(2, '0')}`;
          try { parseDay(dateString); } catch (error) { continue; }
          if (!/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) continue;
          const resolvedPoints = typeof resolvePoints === 'function' ? resolvePoints(taskId) : 0;
          operations.push({
            id: nextId(),
            type: 'task_upsert',
            payload: {
              day: dateString,
              task_id: taskId,
              chun_count: Math.max(0, Math.min(100000, safeInteger(record.chunCount))),
              mao_count: Math.max(0, Math.min(100000, safeInteger(record.maoCount))),
              steal_by: ['chun', 'mao'].includes(record.stealBy) ? record.stealBy : null,
              points_per_unit: Math.max(1, Math.min(100000, safeInteger(record.pointsPerUnit || resolvedPoints, 1)))
            }
          });
        }
      }
    }
    for (const [month, days] of Object.entries(snapshot.audits || {})) {
      for (const [day, audit] of Object.entries(days || {})) {
        const dateString = `${month}-${String(day).padStart(2, '0')}`;
        try { parseDay(dateString); } catch (error) { continue; }
        for (const subject of ['chun', 'mao']) {
          const approved = subject === 'chun' ? audit.chunAuditedByMao : audit.maoAuditedByChun;
          if (!approved) continue;
          operations.push({
            id: nextId(),
            type: 'audit_set',
            payload: { day: dateString, subject, approved: true }
          });
        }
      }
    }
    for (const redemption of snapshot.redemptions || []) {
      try { parseDay(redemption.dateStr); } catch (error) { continue; }
      const redemptionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(redemption.id || '')
        ? redemption.id
        : nextId();
      const itemName = String(redemption.itemName || '').trim().slice(0, 100);
      if (!itemName) continue;
      operations.push({
        id: nextId(),
        type: 'redemption_create',
        payload: {
          redemption_id: redemptionId,
          person: redemption.who === 'chun' ? 'chun' : 'mao',
          item_name: itemName,
          points: Math.max(1, Math.min(100000, safeInteger(redemption.pts, 1))),
          redeemed_on: redemption.dateStr
        }
      });
    }
    for (const task of snapshot.customTasks || []) {
      operations.push({
        id: nextId(),
        type: 'custom_task_upsert',
        payload: { task_id: task.id || `custom_${nextId()}`, definition: task }
      });
    }
    return operations;
  }

  return { applyOperation, overlayPending, parseDay, snapshotToOperations };
});
