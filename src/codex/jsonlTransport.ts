import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { asError } from '../common/errors';

export interface JsonlTransportHandlers {
  readonly onMessage: (message: unknown) => void;
  readonly onMalformedLine: (error: Error) => void;
  readonly onError: (error: Error) => void;
  readonly onClose: () => void;
}

export class JsonlTransport {
  private readonly lines: Interface;
  private disposed = false;

  public constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly handlers: JsonlTransportHandlers
  ) {
    this.lines = createInterface({ input, crlfDelay: Infinity });
    this.lines.on('line', this.handleLine);
    this.lines.on('close', this.handleClose);
    this.input.on('error', this.handleError);
    this.output.on('error', this.handleError);
  }

  public send(message: unknown): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('The JSONL transport is closed.'));
    }

    let line: string;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch (error) {
      return Promise.reject(asError(error));
    }

    return new Promise((resolve, reject) => {
      this.output.write(line, 'utf8', (error?: Error | null) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.lines.off('line', this.handleLine);
    this.lines.off('close', this.handleClose);
    this.input.off('error', this.handleError);
    this.output.off('error', this.handleError);
    this.lines.close();
  }

  private readonly handleLine = (line: string): void => {
    if (!line.trim()) {
      return;
    }

    try {
      this.handlers.onMessage(JSON.parse(line) as unknown);
    } catch (error) {
      this.handlers.onMalformedLine(asError(error));
    }
  };

  private readonly handleError = (error: Error): void => {
    if (!this.disposed) {
      this.handlers.onError(error);
    }
  };

  private readonly handleClose = (): void => {
    if (!this.disposed) {
      this.handlers.onClose();
    }
  };
}
