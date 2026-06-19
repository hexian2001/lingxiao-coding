declare module 'unzipper' {
  import { Readable } from 'stream';

  export interface Entry {
    path: string;
    type: 'Directory' | 'File';
    autodrain(): void;
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    pipe<T extends NodeJS.WritableStream>(destination: T): T;
  }

  export function Parse(): NodeJS.ReadWriteStream;
}
