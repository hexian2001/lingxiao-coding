export interface SessionFactoryDeps<TSession, TInput = string> {
  createRuntime: (input: TInput) => TSession | Promise<TSession>;
  persist?: (session: TSession) => void | Promise<void>;
}

export class SessionFactory<TSession extends { sessionId: string }, TInput = string> {
  private readonly createRuntime: (input: TInput) => TSession | Promise<TSession>;
  private readonly persist?: (session: TSession) => void | Promise<void>;

  constructor(deps: SessionFactoryDeps<TSession, TInput>) {
    this.createRuntime = deps.createRuntime;
    this.persist = deps.persist;
  }

  async create(input: TInput): Promise<TSession> {
    const session = await this.createRuntime(input);
    await this.persist?.(session);
    return session;
  }
}

export default SessionFactory;
