#!/usr/bin/env node
/**
 * router.mjs —— 任务分派调度器（不执行重活）
 *
 * 职责边界（重要）：Router **只做判断和调度**，不跑 shell、不读写项目文件。
 * 它决定「这条任务该不该做、交给谁、能不能现在做」，然后把活交出去。
 * 重活由 Worker 做；Router 被长任务卡住，整个系统就没法接收新任务。
 *
 * 为什么不做成直接调 DSH RPC：Router 跑在引擎进程里，而 `session/create` 等
 * 是宿主（App）侧的编排职责，还带着 workspaceId 这类 Router 看不到的上下文。
 * 所以这里做**纯调度逻辑 + 注入执行器**：
 *   - decide() 是纯函数，可以完整单测
 *   - execute() 接收宿主注入的 createWorker/runTask，不自己调 RPC
 * 这样既能在 Node 里测，又不会假定上游存在某个我没验证过的 API。
 *
 * 关键约束：
 *   - 并发上限：默认 1（iSH 上单进程，多开会互相拖死；实测过）
 *   - 幂等：交给 task-registry 的去重键，Router 不重复建任务
 *   - 不自动重跑有副作用的失败任务：走 needs_reconciliation
 *   - 每个任务只有一个 owner：抢占时校验，不是先到先得
 */
import { load, save, create, transition, enqueue, expired, pendingOutbox } from './task-registry.mjs';
import { gate as gateTask } from './delivery-gate.mjs';

/** 默认并发：1。可被 config 覆盖，但不要在没有实测的情况下调高。 */
export /** 同一原因连续失败到几次就判定「任务需要重新拆解」（移植自 kanban 的 MAX_BLOCKS） */
const MAX_CONSECUTIVE_FAILURES = 2;
const DEFAULT_MAX_CONCURRENT = 1;

/** 任务优先级：用户直接下的最高，webhook 最低。数值越小越先跑。 */
const PRIORITY = { user: 0, schedule: 1, 'agent-message': 2, webhook: 3 };

export class Router {
  /**
   * @param {object} options
   * @param {string} options.dataDir        数据目录（任务表位置）
   * @param {number} [options.maxConcurrent]
   * @param {(task: object) => Promise<{ok: boolean, error?: string, artifacts?: string[], checkpoint?: object}>} [options.runTask]
   *        由宿主注入：真正把任务交给 Worker 执行。不注入时 execute() 只做排队不执行。
   */
  constructor({ dataDir, maxConcurrent = DEFAULT_MAX_CONCURRENT, runTask = null, now = Date.now, requireArtifacts = false } = {}) {
    this.dataDir = dataDir;
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || DEFAULT_MAX_CONCURRENT);
    this.runTask = runTask;
    this.now = now;
    /** 所有任务都必须交产物才算出活（默认关，按项目开）。 */
    this.requireArtifacts = requireArtifacts === true;
  }

  state() { return load(this.dataDir); }

  /**
   * 决定一条新事件该怎么处理。纯函数，不改状态。
   *
   * 两级准入，对应架构里的 Gate 1 / Gate 2：
   *   Gate 1（相关性）：来源是否被允许、是不是重复事件
   *   Gate 2（动作）：忽略 / 记录 / 等审批 / 排队执行 / 立即通知
   *
   * @returns {{action: 'ignore'|'record'|'await_approval'|'enqueue', reason: string, task?: object}}
   */
  decide(event, { allowedSources = ['user', 'schedule', 'agent-message', 'webhook'], requireApproval = [] } = {}) {
    const source = String(event?.source ?? '');
    if (!allowedSources.includes(source)) {
      return { action: 'ignore', reason: `来源 ${source || '(空)'} 不在允许列表` };
    }
    if (!event?.title || !String(event.title).trim()) {
      return { action: 'ignore', reason: '没有标题，不构成任务' };
    }
    // 高风险来源或主题需要人工批准：不是忽略，而是挂着等人。
    const needsApproval = requireApproval.includes(source) || event.requiresApproval === true;
    return {
      action: needsApproval ? 'await_approval' : 'enqueue',
      reason: needsApproval ? '需要用户批准后才执行' : '可排队执行',
    };
  }

  /**
   * 接收一条事件：准入 → 建任务（幂等）→ 排队或等批准 → 尝试调度。
   * @returns {{task: object|null, created: boolean, action: string, reason: string}}
   */
  accept(event, options = {}) {
    const verdict = this.decide(event, options);
    if (verdict.action === 'ignore') {
      return { task: null, created: false, action: 'ignore', reason: verdict.reason };
    }

    const state = this.state();
    const { task, created } = create(state, {
      source: event.source,
      eventId: event.eventId,
      title: event.title,
      sceneId: event.sceneId ?? null,
      parentTaskId: event.parentTaskId ?? null,
      threadKey: event.threadKey ?? null,
      approval: verdict.action === 'await_approval' ? 'pending' : 'none',
    }, this.now());

    if (created) {
      if (verdict.action === 'await_approval') {
        transition(state, task.taskId, 'awaiting_approval', { by: 'router', now: this.now() });
        enqueue(state, {
          kind: 'approval_needed',
          message: `任务「${task.title}」需要你先批准才会执行。`,
          taskId: task.taskId,
          detail: { kind: 'approval_needed', taskId: task.taskId },
        }, this.now());
      } else {
        transition(state, task.taskId, 'queued', { by: 'router', now: this.now() });
      }
      save(state, this.dataDir);
    }

    return {
      task: state.tasks[task.taskId],
      created,
      action: verdict.action,
      reason: verdict.reason,
    };
  }

  /** 批准一个等审批的任务：awaiting_approval → queued。 */
  /**
   * 记一次失败，返回当前连续同因失败次数。
   *
   * 「连续」和「同因」两个条件缺一不可：
   *   - 只按次数：任务修好一半又遇到新问题，会被误判成"老病复发"
   *   - 只按原因：中间成功过再失败，不该算连续
   * 所以成功或进入 running 时必须清零（见 clearFailure）。
   */
  noteFailure(state, taskId, reason) {
    const t = state.tasks[taskId];
    if (!t) return 0;
    const same = t.lastFailReason === reason;
    t.failCount = same ? (t.failCount ?? 0) + 1 : 1;
    t.lastFailReason = reason;
    return t.failCount;
  }

  /** 任务重新开跑或成功时清零连续失败计数。 */
  clearFailure(state, taskId) {
    const t = state.tasks[taskId];
    if (!t) return;
    t.failCount = 0;
    t.lastFailReason = null;
  }

  approve(taskId, by = 'user') {
    const state = this.state();
    transition(state, taskId, 'queued', { by, now: this.now() });
    save(state, this.dataDir);
    return state.tasks[taskId];
  }

  /**
   * 取消任务。queued / running 都可以取消；running 的取消是「标记 + 不再回写」。
   *
   * 为什么 worker 的结果不能覆盖 cancelled：取消的意义就是「我说了停」。
   * 如果慢半拍的结果还能把状态改回 succeeded，取消就成了装饰——用户以为
   * 停了，实际副作用照常发生。runOne 回写前会先看当前状态，非 running 不动。
   *
   * @param {object} [options] force: running 也允许直接标 cancelled
   *        （默认 queued/awaiting_approval 可取消；running 的取消由这里显式授权）
   */
  cancel(taskId, { by = 'user', force = false } = {}) {
    const state = this.state();
    const task = state.tasks[taskId];
    if (!task) throw new Error(`没有这个任务：${taskId}`);
    if (task.status === 'running' && !force) {
      // running 的取消走「标记后等 worker 结束再核对」更稳；这里提供强制档。
      task.cancelRequested = true;
      task.cancelRequestedAt = this.now();
      save(state, this.dataDir);
      return { deferred: true, task };
    }
    transition(state, taskId, 'cancelled', { by, now: this.now() });
    save(state, this.dataDir);
    return { deferred: false, task: state.tasks[taskId] };
  }

  /** 当前可以开跑的任务：按优先级、再按创建时间。 */
  runnable(state = this.state()) {
    const running = Object.values(state.tasks).filter((t) => t.status === 'running');
    const slots = this.maxConcurrent - running.length;
    if (slots <= 0) return [];
    const queued = Object.values(state.tasks)
      .filter((t) => t.status === 'queued')
      .sort((a, b) => (PRIORITY[a.source] ?? 9) - (PRIORITY[b.source] ?? 9) || a.createdAt - b.createdAt);
    return queued.slice(0, slots);
  }

  /**
   * 把排队任务推起来。runTask 未注入时只返回「本可以跑哪些」，不做执行。
   *
   * 执行期错误会被收敛成 task 状态，不向上抛——一个任务失败不该拖垮 Router。
   */
  async execute() {
    const state = this.state();
    const ready = this.runnable(state);
    if (!ready.length) return { started: [], skipped: this.gateReason(state) };
    if (!this.runTask) return { started: [], wouldStart: ready.map((t) => t.taskId) };

    const started = [];
    for (const task of ready) {
      const current = this.state();
      // 抢占前再校验一次：这中间可能有别的进程改了状态（单实例锁之外的兜底）。
      if (current.tasks[task.taskId]?.status !== 'queued') continue;
      transition(current, task.taskId, 'running', { by: 'router', now: this.now() });
      current.tasks[task.taskId].leaseUntil = this.now() + 30 * 60_000;   // 30 分钟租约
      save(current, this.dataDir);

      started.push(task.taskId);
      // 不在循环里 await：并发由 maxConcurrent 控制，这里已按槽位数取过任务。
      void this.runOne(task);
    }
    return { started };
  }

  /** 执行单个任务并把结果落成状态；绝不抛到调用方。 */
  async runOne(task) {
    const state = this.state();
    try {
      const outcome = await this.runTask(task);
      const after = this.state();
      const t = after.tasks[task.taskId];
      if (!t) return;
      // 取消优先于结果：用户说了停，慢半拍的成功也作废。
      // 否则取消是装饰——界面显示已取消，副作用实际照样发生。
      if (t.status !== 'running') return;
      if (outcome?.ok) {
        // 交付 gate：ok:true 只说明「没抛异常」，不等于「东西真的出来了」。
        // 不过 gate 就不算成功——改成 needs_reconciliation，让人看一眼。
        // 这是抄 Blender 插件那条：gate 不过就阻止交付，而不是给个警告继续走。
        const verdict = gateTask(t, outcome, { requireArtifacts: this.requireArtifacts });
        if (!verdict.pass) {
          t.lastError = `交付校验未通过：${verdict.blockers.join('；')}`.slice(0, 500);
          transition(after, task.taskId, 'failed', {
            by: 'gate', error: t.lastError, now: this.now(),
          });
          transition(after, task.taskId, 'needs_reconciliation', { by: 'router', now: this.now() });
          enqueue(after, {
            kind: 'gate_failed',
            message: `任务「${t.title}」没通过交付校验：${verdict.blockers[0] ?? '未知原因'}`,
            taskId: task.taskId,
            detail: { kind: 'gate_failed', taskId: task.taskId, blockers: verdict.blockers },
          }, this.now());
          save(after, this.dataDir);
          void this.execute();
          return;
        }
        if (Array.isArray(outcome.artifacts)) t.artifacts = outcome.artifacts.slice(0, 50);
        if (outcome.checkpoint) t.checkpoint = outcome.checkpoint;
        if (verdict.notes.length) t.gateNotes = verdict.notes.slice(0, 10);
        this.clearFailure(after, task.taskId);
        transition(after, task.taskId, 'succeeded', { by: 'worker', now: this.now() });
      } else {
        transition(after, task.taskId, 'failed', {
          by: 'worker', error: outcome?.error ?? '未知失败', now: this.now(),
        });
        // 失败任务不自动重跑：进 needs_reconciliation，等人确认。
        transition(after, task.taskId, 'needs_reconciliation', { by: 'router', now: this.now() });

        // 连续失败改道（移植自服务器项目 kanban 的 MAX_BLOCKS）：
        // 同一任务**同一原因**连续失败到阈值，说明任务本身有问题——拆得太粗、
        // 缺信息、或者前提不成立。继续原样重试只会重复烧钱。
        // 这里不打回队列（iOS 上没有人工分诊环节），而是升级通知的措辞，
        // 明确告诉人「别再原样重试了」。
        const reason = String(outcome?.error ?? '未知失败').slice(0, 200);
        const count = this.noteFailure(after, task.taskId, reason);
        const rerouted = count >= MAX_CONSECUTIVE_FAILURES;
        enqueue(after, {
          kind: rerouted ? 'task_needs_redesign' : 'task_failed',
          message: rerouted
            ? `任务「${t.title}」连续 ${count} 次以同样原因失败。别再原样重试了——先拆开或补信息。`
            : `任务「${t.title}」失败了：${reason.slice(0, 120)}`,
          taskId: task.taskId,
          detail: {
            kind: rerouted ? 'task_needs_redesign' : 'task_failed',
            taskId: task.taskId,
            consecutiveFailures: count,
            reason,
          },
        }, this.now());
      }
      save(after, this.dataDir);
    } catch (error) {
      const after = this.state();
      const t = after.tasks[task.taskId];
      if (!t) return;
      t.lastError = String(error?.message ?? error).slice(0, 500);
      if (t.status === 'running') {
        transition(after, task.taskId, 'failed', { by: 'worker', error: String(error?.message ?? error), now: this.now() });
        transition(after, task.taskId, 'needs_reconciliation', { by: 'router', now: this.now() });
      }
      save(after, this.dataDir);
    }
    // 一个跑完立刻尝试补位
    void this.execute();
  }

  /** 没有任务可跑时，给一句人话解释为什么（比空数组好排查）。 */
  gateReason(state) {
    const running = Object.values(state.tasks).filter((t) => t.status === 'running').length;
    if (running >= this.maxConcurrent) return `并发已满（${running}/${this.maxConcurrent}）`;
    const queued = Object.values(state.tasks).filter((t) => t.status === 'queued').length;
    if (queued === 0) return '队列为空';
    return '无可调度任务';
  }

  /** 心跳：Worker 每完成一步调用，延长租约。 */
  heartbeat(taskId, { leaseMs = 30 * 60_000 } = {}) {
    const state = this.state();
    const task = state.tasks[taskId];
    if (!task || task.status !== 'running') return false;
    task.heartbeatAt = this.now();
    task.leaseUntil = this.now() + leaseMs;
    save(state, this.dataDir);
    return true;
  }

  /**
   * watchdog 扫描：租约过期仍标 running 的任务 → interrupted。
   * 注意：只改状态并通知，**不自动重跑**——那个决定要人做。
   */
  sweep() {
    const state = this.state();
    const dead = expired(state, this.now());
    for (const task of dead) {
      transition(state, task.taskId, 'interrupted', { by: 'watchdog', now: this.now() });
      enqueue(state, {
        kind: 'task_interrupted',
        message: `任务「${task.title}」心跳超时，已被标记为中断。`,
        taskId: task.taskId,
        detail: { kind: 'task_interrupted', taskId: task.taskId },
      }, this.now());
    }
    if (dead.length) save(state, this.dataDir);
    return dead.map((t) => t.taskId);
  }

  /** 待投递事件（供外层 flush 到提醒通道）。 */
  pending() {
    return pendingOutbox(this.state());
  }
}
