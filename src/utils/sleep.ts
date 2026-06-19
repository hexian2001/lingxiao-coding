/**
 * 异步 sleep 工具：避免每个调用方各自写 `new Promise(r => setTimeout(r, ms))`。
 *
 * 注意：底层 timer 默认会保活事件循环，长 idle 进程不需要这种行为时调用方应自行 unref。
 * 此处不在 utils 里隐式 unref —— 让调用方按场景决定。
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
