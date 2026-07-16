import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface, type Interface } from 'node:readline';
import { AppServerError, AppServerRequestError, asError } from '../common/errors';
import {
  CodexExecutableResolverError,
  probeCodexVersion,
  resolveCodexCommand,
  type CodexCommand,
  type CodexCommandSource,
  type CodexVersionProbe
} from './codexExecutableResolver';
import { JsonlTransport } from './jsonlTransport';
import type { ClientRequest } from './protocol/generated/ClientRequest';
import type { InitializeParams } from './protocol/generated/InitializeParams';
import type { InitializeResponse } from './protocol/generated/InitializeResponse';
import type { RequestId } from './protocol/generated/RequestId';
import type { ThreadListParams } from './protocol/generated/v2/ThreadListParams';
import type { ThreadListResponse } from './protocol/generated/v2/ThreadListResponse';
import { GENERATED_CODEX_CLI_VERSION } from './protocol/generated/version';
import {
  isJsonObject,
  isRequestId,
  parseInitializeResponse,
  parseThreadListResponse
} from './protocol/guards';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const SERVER_REQUEST_NOT_SUPPORTED = -32601;

export interface AppServerLogger {
  appendLine(value: string): void;
}

export interface AppServerClientOptions {
  readonly codexPath: string;
  readonly clientVersion: string;
  readonly logger: AppServerLogger;
  readonly requestTimeoutMs?: number;
  readonly commandResolver?: (configuredPath: string) => Promise<CodexCommand>;
  readonly versionProbe?: (command: CodexCommand) => Promise<CodexVersionProbe>;
}

export type AppServerCompatibility = 'unchecked' | 'compatible' | 'incompatible';

export interface AppServerDiagnostics {
  readonly compatibility: AppServerCompatibility;
  readonly generatedVersion: string;
  readonly resolvedPath: string | undefined;
  readonly runtimeVersion: string | undefined;
  readonly source: CodexCommandSource | undefined;
}

export interface AppServerNotification {
  readonly method: string;
  readonly params?: unknown;
}

interface PendingRequest {
  readonly method: string;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

type ConnectionState = 'idle' | 'starting' | 'ready' | 'disposed';

export class AppServerClient {
  private readonly notifications = new EventEmitter();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private process: ChildProcessWithoutNullStreams | undefined;
  private transport: JsonlTransport | undefined;
  private stderrLines: Interface | undefined;
  private connectPromise: Promise<InitializeResponse> | undefined;
  private initializeResponse: InitializeResponse | undefined;
  private nextRequestId = 1;
  private state: ConnectionState = 'idle';
  private diagnostics: AppServerDiagnostics = {
    compatibility: 'unchecked',
    generatedVersion: GENERATED_CODEX_CLI_VERSION,
    resolvedPath: undefined,
    runtimeVersion: undefined,
    source: undefined
  };

  public constructor(private readonly options: AppServerClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  public onNotification(listener: (notification: AppServerNotification) => void): { dispose(): void } {
    this.notifications.on('notification', listener);
    return {
      dispose: () => {
        this.notifications.off('notification', listener);
      }
    };
  }

  public onDidDisconnect(listener: (error: AppServerError) => void): { dispose(): void } {
    this.notifications.on('disconnect', listener);
    return {
      dispose: () => {
        this.notifications.off('disconnect', listener);
      }
    };
  }

  public getDiagnostics(): AppServerDiagnostics {
    return { ...this.diagnostics };
  }

  public connect(): Promise<InitializeResponse> {
    if (this.state === 'disposed') {
      return Promise.reject(new AppServerError('disposed', 'The App Server client has been disposed.'));
    }

    if (this.initializeResponse) {
      return Promise.resolve(this.initializeResponse);
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.state = 'starting';
    this.connectPromise = this.startConnection().catch((error: unknown) => {
      const connectionError = this.classifyRequiredProtocolError(
        error,
        'Failed to initialize Codex App Server.'
      );
      this.stopProcess(connectionError, false);
      throw connectionError;
    });

    return this.connectPromise;
  }

  public async listThreads(params: ThreadListParams): Promise<ThreadListResponse> {
    await this.connect();
    try {
      const result = await this.sendRequest((id) => ({ method: 'thread/list', id, params }));
      const response = parseThreadListResponse(result);
      if (this.diagnostics.compatibility !== 'compatible') {
        this.diagnostics = { ...this.diagnostics, compatibility: 'compatible' };
        this.options.logger.appendLine(
          '[compatibility] Required initialize/thread/list methods and response boundaries are compatible.'
        );
      }
      return response;
    } catch (error) {
      const classified = this.classifyRequiredProtocolError(error, 'thread/list failed.');
      if (classified.code === 'incompatible-cli') {
        this.stopProcess(classified, false);
      }
      throw classified;
    }
  }

  public dispose(): void {
    if (this.state === 'disposed') {
      return;
    }

    this.state = 'disposed';
    this.stopProcess(new AppServerError('disposed', 'The App Server client was disposed.'), true);
    this.notifications.removeAllListeners();
  }

  private async initialize(): Promise<InitializeResponse> {
    const params: InitializeParams = {
      clientInfo: {
        name: 'codex_thread_manager_vscode',
        title: 'Codex Thread Manager for VS Code',
        version: this.options.clientVersion
      },
      capabilities: null
    };
    const result = await this.sendRequest((id) => ({ method: 'initialize', id, params }));

    let response: InitializeResponse;
    try {
      response = parseInitializeResponse(result);
    } catch (error) {
      throw new AppServerError('protocol-error', asError(error).message, { cause: error });
    }

    await this.requireTransport().send({ method: 'initialized' });
    this.initializeResponse = response;
    this.state = 'ready';
    this.options.logger.appendLine(
      `[app-server] Initialized ${response.userAgent} on ${response.platformFamily}/${response.platformOs}.`
    );
    return response;
  }

  private async startConnection(): Promise<InitializeResponse> {
    this.diagnostics = {
      compatibility: 'unchecked',
      generatedVersion: GENERATED_CODEX_CLI_VERSION,
      resolvedPath: undefined,
      runtimeVersion: undefined,
      source: undefined
    };
    let command: CodexCommand;
    try {
      command = this.options.commandResolver
        ? await this.options.commandResolver(this.options.codexPath)
        : await resolveCodexCommand({ configuredPath: this.options.codexPath });
    } catch (error) {
      if (error instanceof CodexExecutableResolverError) {
        throw new AppServerError('cli-not-found', error.message, { cause: error });
      }
      throw new AppServerError(
        'process-start-failed',
        `Could not resolve Codex CLI: ${asError(error).message}`,
        { cause: error }
      );
    }

    if (this.state === 'disposed') {
      throw new AppServerError('disposed', 'The App Server client has been disposed.');
    }

    this.diagnostics = {
      ...this.diagnostics,
      resolvedPath: command.resolvedPath,
      source: command.source
    };
    this.options.logger.appendLine(
      `[cli] Resolved Codex CLI (${command.source}): ${command.resolvedPath}`
    );
    await this.recordVersionDiagnostics(command);
    this.startProcess(command);
    return this.initialize();
  }

  private async recordVersionDiagnostics(command: CodexCommand): Promise<void> {
    try {
      const result = this.options.versionProbe
        ? await this.options.versionProbe(command)
        : await probeCodexVersion(command);
      this.diagnostics = { ...this.diagnostics, runtimeVersion: result.version };
      this.options.logger.appendLine(
        `[compatibility] Runtime Codex CLI: ${result.version ?? (result.raw || 'unknown')}; generated protocol: ${GENERATED_CODEX_CLI_VERSION}.`
      );
      if (result.version && result.version !== GENERATED_CODEX_CLI_VERSION) {
        this.options.logger.appendLine(
          '[compatibility] Version mismatch detected; continuing with required protocol checks.'
        );
      }
    } catch (error) {
      this.options.logger.appendLine(
        `[compatibility] Could not read codex --version (${asError(error).message}); generated protocol: ${GENERATED_CODEX_CLI_VERSION}. Continuing with protocol checks.`
      );
    }
  }

  private startProcess(command: CodexCommand): void {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command.executable, [...command.prefixArgs, 'app-server', '--listen', 'stdio://'], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      throw this.createProcessStartError(error);
    }

    this.process = child;
    this.transport = new JsonlTransport(child.stdout, child.stdin, {
      onMessage: (message) => this.handleMessage(child, message),
      onMalformedLine: (error) => {
        this.options.logger.appendLine(`[app-server] Ignored malformed JSONL output: ${error.message}`);
      },
      onError: (error) => this.handleDisconnect(child, this.normalizeConnectionError(error, 'App Server I/O failed.')),
      onClose: () => this.handleDisconnect(child, new AppServerError('connection-closed', 'App Server output closed.'))
    });

    this.stderrLines = createInterface({ input: child.stderr, crlfDelay: Infinity });
    this.stderrLines.on('line', (line) => {
      const diagnostic = redactDiagnostic(line.trim());
      if (diagnostic) {
        this.options.logger.appendLine(`[app-server stderr] ${diagnostic}`);
      }
    });
    child.once('error', (error) => this.handleDisconnect(child, this.createProcessStartError(error)));
    child.once('exit', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      this.handleDisconnect(child, new AppServerError('connection-closed', `App Server exited with ${detail}.`));
    });
  }

  private sendRequest(createRequest: (id: RequestId) => ClientRequest): Promise<unknown> {
    const transport = this.requireTransport();
    const id = this.nextRequestId++;
    const request = createRequest(id);
    const key = requestKey(id);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(key);
        reject(
          new AppServerError(
            'request-timeout',
            `${request.method} timed out after ${this.requestTimeoutMs} ms.`
          )
        );
      }, this.requestTimeoutMs);

      this.pendingRequests.set(key, { method: request.method, timer, resolve, reject });
      void transport.send(request).catch((error: unknown) => {
        const pending = this.pendingRequests.get(key);
        if (!pending) {
          return;
        }

        clearTimeout(pending.timer);
        this.pendingRequests.delete(key);
        pending.reject(this.normalizeConnectionError(error, `Failed to send ${request.method}.`));
      });
    });
  }

  private handleMessage(child: ChildProcessWithoutNullStreams, message: unknown): void {
    if (this.process !== child || !isJsonObject(message)) {
      this.options.logger.appendLine('[app-server] Ignored a malformed protocol message.');
      return;
    }

    if ('id' in message && isRequestId(message.id) && ('result' in message || 'error' in message)) {
      this.handleResponse(message);
      return;
    }

    if (typeof message.method === 'string') {
      if ('id' in message && isRequestId(message.id)) {
        void this.rejectServerRequest(message.id, message.method);
      } else {
        this.notifications.emit('notification', { method: message.method, params: message.params });
      }
      return;
    }

    this.options.logger.appendLine('[app-server] Ignored an unrecognized protocol message.');
  }

  private handleResponse(message: Record<string, unknown>): void {
    const id = message.id;
    if (!isRequestId(id)) {
      return;
    }

    const key = requestKey(id);
    const pending = this.pendingRequests.get(key);
    if (!pending) {
      this.options.logger.appendLine(`[app-server] Ignored a response for unknown request ${String(id)}.`);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(key);

    if ('error' in message) {
      if (isJsonObject(message.error) && typeof message.error.code === 'number' && typeof message.error.message === 'string') {
        pending.reject(new AppServerRequestError(pending.method, message.error.code, message.error.message));
      } else {
        pending.reject(new AppServerError('protocol-error', `${pending.method} returned an invalid error response.`));
      }
      return;
    }

    pending.resolve(message.result);
  }

  private async rejectServerRequest(id: RequestId, method: string): Promise<void> {
    this.options.logger.appendLine(`[app-server] Rejected unsupported server request ${method}.`);
    try {
      await this.requireTransport().send({
        id,
        error: {
          code: SERVER_REQUEST_NOT_SUPPORTED,
          message: `Client does not support server request ${method}.`
        }
      });
    } catch (error) {
      this.options.logger.appendLine(`[app-server] Failed to reject server request: ${asError(error).message}`);
    }
  }

  private handleDisconnect(child: ChildProcessWithoutNullStreams, error: AppServerError): void {
    if (this.process !== child || this.state === 'disposed') {
      return;
    }

    const wasReady = this.state === 'ready';
    this.options.logger.appendLine(`[app-server] ${error.message}`);
    this.stopProcess(error, false);
    if (wasReady) {
      this.notifications.emit('disconnect', error);
    }
  }

  private stopProcess(error: AppServerError, disposing: boolean): void {
    const child = this.process;
    this.process = undefined;
    this.transport?.dispose();
    this.transport = undefined;
    this.stderrLines?.close();
    this.stderrLines = undefined;
    this.initializeResponse = undefined;
    this.connectPromise = undefined;

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();

    if (child) {
      child.stdin.end();
      if (!child.killed) {
        child.kill();
      }
    }

    if (!disposing) {
      this.state = 'idle';
    }
  }

  private requireTransport(): JsonlTransport {
    if (!this.transport) {
      throw new AppServerError('connection-closed', 'Codex App Server is not connected.');
    }
    return this.transport;
  }

  private createProcessStartError(value: unknown): AppServerError {
    const error = asError(value) as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      return new AppServerError(
        'cli-not-found',
        'The resolved Codex CLI executable could not be started.',
        { cause: error }
      );
    }
    return new AppServerError('process-start-failed', `Could not start Codex App Server: ${error.message}`, {
      cause: error
    });
  }

  private normalizeConnectionError(value: unknown, fallbackMessage: string): AppServerError {
    if (value instanceof AppServerError) {
      return value;
    }
    const error = asError(value);
    return new AppServerError('connection-closed', error.message || fallbackMessage, { cause: error });
  }

  private classifyRequiredProtocolError(value: unknown, fallbackMessage: string): AppServerError {
    const requiredMethodMissing = value instanceof AppServerRequestError && value.requestCode === -32601;
    const invalidBoundary = !(value instanceof AppServerError) || value.code === 'protocol-error';
    if (requiredMethodMissing || invalidBoundary) {
      this.diagnostics = { ...this.diagnostics, compatibility: 'incompatible' };
      const runtimeVersion = this.diagnostics.runtimeVersion ?? 'unknown';
      const detail = asError(value).message || fallbackMessage;
      this.options.logger.appendLine(
        `[compatibility] Incompatible required protocol: ${detail} Runtime=${runtimeVersion}; generated=${GENERATED_CODEX_CLI_VERSION}.`
      );
      return new AppServerError(
        'incompatible-cli',
        `Codex CLI ${runtimeVersion} is incompatible with generated protocol ${GENERATED_CODEX_CLI_VERSION}: ${detail}`,
        { cause: value }
      );
    }
    return this.normalizeConnectionError(value, fallbackMessage);
  }
}

function requestKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

function redactDiagnostic(value: string): string {
  return value
    .slice(0, 2_000)
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]');
}
