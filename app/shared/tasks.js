/*
 * 任务记录（任务中心的数据源）。
 *
 * 阶段一不做后台任务管理器，但「任务中心什么都没有」是不能接受的：
 * 这里用「按运行快照补记」的方式落一份真实记录 —— 谁拿到运行快照（开始、storage 回传、
 * 面板重开后的恢复）就调一次 recordRun，同一个 signature 只对应一条记录，
 * 反复调用只是把同一条更新到最新状态，不会重复、也不会凭空造数据。
 *
 * 写入串行化：读-改-写全在一个队列里跑，避免进度快速回传时互相覆盖。
 */

import { KEYS, read, write } from './storage.js';

const MAX_TASKS = 40;

let chain = Promise.resolve();

function mutate(handler) {
  const run = chain.then(async () => {
    const stored = await read(KEYS.tasks, []);
    const tasks = Array.isArray(stored) ? stored.slice() : [];
    const output = handler(tasks);
    const trimmed = tasks
      .slice()
      .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
      .slice(0, MAX_TASKS);
    await write(KEYS.tasks, trimmed);
    return output;
  });
  // 出错不能把队列卡死，也不能吞掉调用方的 catch
  chain = run.then(() => {}, () => {});
  return run;
}

/**
 * 由运行快照推导任务状态。
 * done < total 且已经不在跑，说明是中途停的；但只要已经有失败项，优先显示「部分失败」，
 * 因为用户关心的是失败原因，条数在看板副标题里已经写了。
 */
export function runStatus({ running, total, done, failed = 0 }) {
  if (running) return 'running';
  if (!total || done === 0) return 'failed';
  if (failed > 0) return 'completed_with_errors';
  if (done < total) return 'cancelled';
  return 'completed';
}

/**
 * 记录/更新一条任务。
 * @param {object} payload
 * @param {string} payload.signature 同一次运行的唯一标识（runId 派生），相同则更新同一条
 * @param {string} payload.featureId
 * @param {string} [payload.platformId]
 * @param {string} [payload.name]
 * @param {string} payload.status 8 种状态之一
 * @param {number} [payload.total]
 * @param {number} [payload.done]
 * @param {number} [payload.success]
 * @param {number} [payload.failed]
 * @param {number} [payload.at] 快照时间（结束时间）
 * @param {number} [payload.startedAt]
 */
export async function recordRun(payload) {
  const signature = String(payload && payload.signature || '');
  if (!signature) return null;
  const at = Number(payload.at) || Date.now();
  const status = payload.status || 'running';

  return mutate(tasks => {
    const index = tasks.findIndex(task => task.signature === signature);
    const existing = index >= 0 ? tasks[index] : null;
    const base = existing || {
      id: `t${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      signature,
      featureId: payload.featureId,
      platformId: payload.platformId || '',
      name: payload.name || '',
      createdAt: Number(payload.startedAt) || at,
      startedAt: Number(payload.startedAt) || at,
      endedAt: 0,
    };

    const task = {
      ...base,
      status,
      progress: {
        done: Math.max(0, Number(payload.done) || 0),
        total: Math.max(0, Number(payload.total) || 0),
      },
      result: {
        success: Math.max(0, Number(payload.success) || 0),
        failed: Math.max(0, Number(payload.failed) || 0),
      },
      updatedAt: Date.now(),
    };
    if (status !== 'running') task.endedAt = task.endedAt || at;
    if (index >= 0) tasks[index] = task;
    else tasks.push(task);
    return task;
  });
}

export async function listTasks() {
  const stored = await read(KEYS.tasks, []);
  const tasks = Array.isArray(stored) ? stored : [];
  return tasks.slice().sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
}

/**
 * 已结束的状态白名单：**只有**这些允许清理。
 * 用白名单而不是「排除 running/pending/paused」：以后加新状态（比如重试中）时，
 * 未知状态默认保留，宁可留一条多余记录，也不会把还在跑的记录删掉。
 */
const FINISHED_STATUS = ['completed', 'completed_with_errors', 'failed', 'cancelled', 'interrupted'];

/** 这条记录是否已经结束（可以清理）；进行中、状态未知都返回 false */
export function isFinishedTask(task) {
  return Boolean(task) && FINISHED_STATUS.includes(String(task.status || ''));
}

/**
 * 清理**已结束**的任务记录，进行中的保留。
 * 走和 recordRun 同一条写队列：否则清理的读-改-写可能和正在回传的进度撞车，
 * 把刚写进来的新进度覆盖掉。
 */
export async function clearFinishedTasks() {
  return mutate(tasks => {
    const keep = tasks.filter(task => !isFinishedTask(task));
    const removed = tasks.length - keep.length;
    tasks.length = 0;
    keep.forEach(task => tasks.push(task));
    return { removed, kept: keep.length };
  });
}

/** 只清理任务记录 */
export async function clearTasks() {
  await write(KEYS.tasks, []);
}
