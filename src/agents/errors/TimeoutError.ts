/**
 * TimeoutError - Agent 执行超时错误
 * 
 * 用于标识 Agent 执行超时,触发 Conclude 阶段
 */
export class TimeoutError extends Error {
  constructor(
    message: string,
    public readonly agentId: string,
    public readonly iteration: number,
    public readonly elapsedMinutes: number,
  ) {
    super(message);
    this.name = 'TimeoutError';
    
    // 保持正确的原型链
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}
