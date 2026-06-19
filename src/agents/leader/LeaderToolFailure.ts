/**
 * Leader 元工具的确定性失败信号。
 *
 * 背景：LeaderToolsExecutor 的方法对成功和失败都返回普通字符串，
 * LeaderMetaTool.execute 曾无条件包成 { success: true }，导致失败被
 * 当成成功回流给 LLM（幻觉「已派发」「已写入」）。
 *
 * 契约：方法在**未能完成其主操作**时 `throw fail(msg)` 或 `throw fail(msg, 'skipped')`，
 * 成功仍 `return '<msg>'`。LeaderMetaTool.execute 捕获 LeaderToolFailure →
 * { success: false, error }，下游自动加 ERROR: 前缀，LLM 才能看见失败。
 *
 * status 仅 dispatch_batch 的内部归类（ok/skipped/failed 计数）使用；
 * 其它场景一律默认 'failed'，因为唯一消费者是 LeaderMetaTool（任何抛错=ERROR）。
 */

export type DispatchItemStatus = 'ok' | 'skipped' | 'failed';

export class LeaderToolFailure extends Error {
  readonly status: DispatchItemStatus;

  constructor(message: string, status: DispatchItemStatus = 'failed') {
    super(message);
    this.name = 'LeaderToolFailure';
    this.status = status;
  }
}

/** 便捷构造器：抛出一个 Leader 元工具失败。status 默认 'failed'。 */
export const fail = (message: string, status: DispatchItemStatus = 'failed'): LeaderToolFailure =>
  new LeaderToolFailure(message, status);
