import { EventEmitter } from 'events';
import type { Readable } from 'stream';

export class LineReader extends EventEmitter {
  private buffer = '';

  constructor(stream: Readable) {
    super();
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => this.push(chunk));
    stream.on('end', () => this.flush());
    stream.on('error', (error) => this.emit('error', error));
  }

  private push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      this.emit('line', line);
    }
  }

  private flush(): void {
    if (this.buffer.length > 0) {
      this.emit('line', this.buffer);
      this.buffer = '';
    }
    this.emit('close');
  }
}

export function createLineReader(stream: Readable): LineReader {
  return new LineReader(stream);
}
