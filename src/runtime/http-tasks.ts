const requestTasks = new WeakMap<Promise<void>, Set<Promise<unknown>>>();

/** Associates durable application writes with the real transport receipt. */
export const trackRequestTask = (completed: Promise<void> | undefined, task: Promise<unknown>): void => {
  if (!completed) return;
  const tasks = requestTasks.get(completed);
  if (!tasks) return;
  tasks.add(task);
  void task.finally(() => tasks.delete(task)).catch(() => {});
};

export const createRequestTaskDrain = (completed: Promise<void>): (() => Promise<void>) => {
  const tasks = new Set<Promise<unknown>>();
  requestTasks.set(completed, tasks);
  return async () => {
    while (tasks.size) await Promise.allSettled([...tasks]);
    requestTasks.delete(completed);
  };
};
