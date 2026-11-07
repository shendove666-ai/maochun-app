(function (root) {
  'use strict';

  const TABLES = ['task_daily_state', 'audits', 'redemptions', 'custom_tasks'];

  function firstRow(data) {
    return Array.isArray(data) ? data[0] || null : data || null;
  }

  function throwIfError(result, label) {
    if (result && result.error) {
      const error = new Error(`${label}：${result.error.message}`);
      error.cause = result.error;
      throw error;
    }
    return result ? result.data : null;
  }

  function isPermanentOperationError(error) {
    const code = String(error?.code || '');
    const message = `${error?.message || ''} ${error?.details || ''}`;
    return ['22P02', '22003', '23502', '23514'].includes(code)
      || /\b(?:INVALID_[A-Z_]+|UNKNOWN_OPERATION|INSUFFICIENT_[A-Z_]+)\b/.test(message);
  }

  class MaoChunSync {
    constructor(callbacks) {
      this.callbacks = callbacks || {};
      this.client = null;
      this.family = null;
      this.channel = null;
      this.flushing = false;
      this.refreshTimer = null;
      this.deviceId = this.callbacks.getDeviceId ? this.callbacks.getDeviceId() : crypto.randomUUID();
      this.config = root.MAOCHUN_CONFIG || {};
      this.boundOnline = () => {
        this.setStatus('connecting', '网络已恢复，正在同步…');
        this.flushPending();
      };
      this.boundOffline = () => this.setStatus('offline', '离线使用，操作会在联网后上传');
      this.boundVisibility = () => {
        if (document.visibilityState === 'visible' && navigator.onLine) {
          this.flushPending();
          this.scheduleRefresh(0);
        }
      };
    }

    get configured() {
      return Boolean(this.config.supabaseUrl && this.config.supabaseAnonKey);
    }

    setStatus(status, message, detail) {
      if (this.callbacks.onStatus) this.callbacks.onStatus({ status, message, detail: detail || '' });
    }

    async init() {
      window.addEventListener('online', this.boundOnline);
      window.addEventListener('offline', this.boundOffline);
      document.addEventListener('visibilitychange', this.boundVisibility);

      if (!this.configured) {
        this.setStatus('local', '本机保存正常；云同步等待配置');
        return { configured: false };
      }
      if (!root.supabase || typeof root.supabase.createClient !== 'function') {
        this.setStatus('error', '云同步组件加载失败，请检查网络');
        return { configured: true, error: 'SUPABASE_LIBRARY_MISSING' };
      }

      this.setStatus('connecting', '正在连接家庭账本…');
      try {
        this.client = root.supabase.createClient(
          this.config.supabaseUrl,
          this.config.supabaseAnonKey,
          {
            auth: {
              persistSession: true,
              autoRefreshToken: true,
              detectSessionInUrl: false
            }
          }
        );

        let sessionResult = await this.client.auth.getSession();
        if (sessionResult.error) throw sessionResult.error;
        if (!sessionResult.data.session) {
          const signInResult = await this.client.auth.signInAnonymously();
          if (signInResult.error) throw signInResult.error;
          sessionResult = await this.client.auth.getSession();
        }

        await this.loadCurrentFamily();
        if (!this.family) {
          this.setStatus('needs_family', '请选择创建家庭或用邀请码加入');
          return { configured: true, family: null };
        }

        await this.subscribe();
        await this.refresh();
        await this.flushPending();
        return { configured: true, family: this.family };
      } catch (error) {
        this.setStatus('error', '云同步连接失败，本机数据仍然安全', error.message);
        return { configured: true, error: error.message };
      }
    }

    async loadCurrentFamily() {
      const result = await this.client.rpc('current_household');
      const family = firstRow(throwIfError(result, '读取家庭信息失败'));
      this.family = family
        ? {
            id: family.household_id,
            name: family.household_name,
            displayName: family.display_name,
            memberRole: family.member_role,
            personRole: family.person_role,
            deviceName: family.device_name
          }
        : null;
      if (this.callbacks.onFamily) this.callbacks.onFamily(this.family);
      return this.family;
    }

    async createHousehold({ familyName, displayName, personRole, deviceName }) {
      if (!this.client) throw new Error('云同步尚未初始化');
      this.setStatus('connecting', '正在创建家庭账本…');
      const result = await this.client.rpc('create_household', {
        p_name: familyName,
        p_display_name: displayName,
        p_person_role: personRole,
        p_device_name: deviceName
      });
      const created = firstRow(throwIfError(result, '创建家庭失败'));
      await this.loadCurrentFamily();
      await this.subscribe();
      this.setStatus('synced', '家庭账本已创建');
      return created;
    }

    async joinHousehold({ inviteToken, displayName, personRole, deviceName }) {
      if (!this.client) throw new Error('云同步尚未初始化');
      this.setStatus('connecting', '正在加入家庭账本…');
      const result = await this.client.rpc('join_household', {
        p_invite_token: inviteToken,
        p_display_name: displayName,
        p_person_role: personRole,
        p_device_name: deviceName
      });
      throwIfError(result, '加入家庭失败');
      await this.loadCurrentFamily();
      await this.subscribe();
      await this.refresh();
      this.setStatus('synced', '已加入家庭账本');
      return this.family;
    }

    async subscribe() {
      if (!this.client || !this.family) return;
      if (this.channel) await this.client.removeChannel(this.channel);
      this.channel = this.client.channel(`household:${this.family.id}`);
      for (const table of TABLES) {
        this.channel.on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table,
            filter: `household_id=eq.${this.family.id}`
          },
          () => this.scheduleRefresh(180)
        );
      }
      this.channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          this.setStatus('synced', '已连接，三台设备会自动更新');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          this.setStatus('error', '实时连接暂时中断，正在自动重试');
        }
      });
    }

    scheduleRefresh(delay = 180) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.refresh().catch((error) => {
        this.setStatus('error', '刷新云端账本失败', error.message);
      }), delay);
    }

    async refresh() {
      if (!this.client || !this.family || !navigator.onLine) return null;
      this.setStatus('syncing', '正在接收最新账本…');
      const householdId = this.family.id;
      const [taskResult, auditResult, redemptionResult, customTaskResult] = await Promise.all([
        this.client.from('task_daily_state').select('*').eq('household_id', householdId).is('deleted_at', null),
        this.client.from('audits').select('*').eq('household_id', householdId),
        this.client.from('redemptions').select('*').eq('household_id', householdId).is('cancelled_at', null),
        this.client.from('custom_tasks').select('*').eq('household_id', householdId).is('deleted_at', null)
      ]);

      const tasks = throwIfError(taskResult, '读取打卡记录失败') || [];
      const audits = throwIfError(auditResult, '读取审核记录失败') || [];
      const redemptions = throwIfError(redemptionResult, '读取兑换记录失败') || [];
      const customTasks = throwIfError(customTaskResult, '读取自定义项目失败') || [];
      const snapshot = { records: {}, audits: {}, redemptions: [], customTasks: [] };

      for (const row of tasks) {
        const match = /^(\d{4}-\d{2})-(\d{2})$/.exec(row.day);
        if (!match) continue;
        const month = match[1];
        const day = String(Number(match[2]));
        if (!snapshot.records[month]) snapshot.records[month] = {};
        if (!snapshot.records[month][day]) snapshot.records[month][day] = {};
        snapshot.records[month][day][row.task_id] = {
          chunCount: Number(row.chun_count || 0),
          maoCount: Number(row.mao_count || 0),
          stealBy: row.steal_by || null,
          pointsPerUnit: Number(row.points_per_unit || 0),
          updatedAt: row.updated_at
        };
      }
      for (const row of audits) {
        const match = /^(\d{4}-\d{2})-(\d{2})$/.exec(row.day);
        if (!match) continue;
        const month = match[1];
        const day = String(Number(match[2]));
        if (!snapshot.audits[month]) snapshot.audits[month] = {};
        if (!snapshot.audits[month][day]) {
          snapshot.audits[month][day] = { chunAuditedByMao: false, maoAuditedByChun: false };
        }
        if (row.subject === 'chun') snapshot.audits[month][day].chunAuditedByMao = Boolean(row.approved);
        if (row.subject === 'mao') snapshot.audits[month][day].maoAuditedByChun = Boolean(row.approved);
      }
      snapshot.redemptions = redemptions.map((row) => ({
        id: row.id,
        dateStr: row.redeemed_on,
        who: row.person,
        itemName: row.item_name,
        pts: Number(row.points)
      }));
      snapshot.customTasks = customTasks.map((row) => ({ ...row.definition, id: row.task_id }));

      if (this.callbacks.onSnapshot) this.callbacks.onSnapshot(snapshot);
      const pendingCount = this.callbacks.getPendingOperations ? this.callbacks.getPendingOperations().length : 0;
      this.setStatus(pendingCount ? 'pending' : 'synced', pendingCount ? `还有 ${pendingCount} 条操作等待上传` : '所有设备数据已同步');
      return snapshot;
    }

    async flushPending() {
      if (this.flushing || !this.client || !this.family) return;
      if (!navigator.onLine) {
        this.setStatus('offline', '离线使用，操作会在联网后上传');
        return;
      }
      this.flushing = true;
      try {
        let pending = this.callbacks.getPendingOperations ? this.callbacks.getPendingOperations() : [];
        while (pending.length) {
          const operation = pending[0];
          this.setStatus('syncing', `正在上传 ${pending.length} 条操作…`);
          const result = await this.client.rpc('apply_operation', {
            p_id: operation.id,
            p_household_id: this.family.id,
            p_device_id: this.deviceId,
            p_type: operation.type,
            p_payload: operation.payload,
            p_client_created_at: operation.client_created_at
          });
          if (result.error && isPermanentOperationError(result.error) && this.callbacks.onOperationRejected) {
            this.callbacks.onOperationRejected(operation.id, result.error.message || '操作内容无效');
            pending = this.callbacks.getPendingOperations ? this.callbacks.getPendingOperations() : [];
            continue;
          }
          throwIfError(result, '上传操作失败');
          if (this.callbacks.onOperationAck) this.callbacks.onOperationAck(operation.id);
          pending = this.callbacks.getPendingOperations ? this.callbacks.getPendingOperations() : [];
        }
        await this.refresh();
      } catch (error) {
        this.setStatus('error', '同步失败，已保留在本机并会自动重试', error.message);
      } finally {
        this.flushing = false;
      }
    }
  }

  root.MaoChunSync = MaoChunSync;
})(window);
