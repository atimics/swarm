/**
 * Runtime supervisor — launches and supervises external agent-backend runtimes
 * (Hermes, elizaOS, OpenClaw, …) as managed child processes of the local sidecar.
 *
 * Each backend is spawned through a shell so a full launch command line works
 * ("hermes serve --port 7331"). Children are started in their own process group
 * (detached) so we can signal the whole tree on stop, and stopAll() runs on
 * sidecar shutdown so we never orphan a runtime.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';

const MAX_LOG_LINES = 200;

export type RuntimeState = {
  backend: string;
  running: boolean;
  pid: number | null;
  startedAt: number | null;
  command: string | null;
  endpoint: string | null;
  exitCode: number | null;
  lastError: string | null;
};

type Entry = {
  child: ChildProcess | null;
  pid: number | null;
  command: string;
  endpoint: string | null;
  startedAt: number | null;
  exitCode: number | null;
  lastError: string | null;
  logs: string[];
};

export class RuntimeSupervisor {
  private entries = new Map<string, Entry>();

  private isRunning(entry: Entry | undefined): entry is Entry {
    return Boolean(entry?.child && entry.child.exitCode === null && !entry.child.killed);
  }

  status(backend: string): RuntimeState {
    const entry = this.entries.get(backend);
    const running = this.isRunning(entry);
    return {
      backend,
      running,
      pid: running ? entry!.pid : null,
      startedAt: running ? entry?.startedAt ?? null : null,
      command: entry?.command ?? null,
      endpoint: entry?.endpoint ?? null,
      exitCode: entry?.exitCode ?? null,
      lastError: entry?.lastError ?? null,
    };
  }

  logs(backend: string): string[] {
    return this.entries.get(backend)?.logs ?? [];
  }

  private signal(entry: Entry, signal: NodeJS.Signals): void {
    if (!this.isRunning(entry) || entry.pid == null) return;
    const pid = entry.pid;
    try {
      // Negative pid -> signal the whole detached process group.
      process.kill(-pid, signal);
    } catch {
      try {
        entry.child!.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }

  private stopNamedDockerContainer(entry: Entry | undefined): void {
    const command = entry?.command ?? '';
    if (!/\bdocker\s+run\b/.test(command)) return;
    const named = command.match(/--name[=\s]+([A-Za-z0-9._-]+)/);
    if (!named) return;
    try {
      execFileSync('docker', ['stop', named[1]], { stdio: 'ignore', timeout: 5000 });
    } catch {
      /* docker not installed or container already gone */
    }
  }

  start(backend: string, command: string, endpoint: string | null): RuntimeState {
    const existing = this.entries.get(backend);
    const priorLogs = existing?.logs ?? [];
    if (this.isRunning(existing)) return this.status(backend);

    const entry: Entry = {
      child: null,
      pid: null,
      command,
      endpoint,
      startedAt: Date.now(),
      exitCode: null,
      lastError: null,
      logs: priorLogs,
    };
    this.entries.set(backend, entry);

    const append = (prefix: string, chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        entry.logs.push(`[${prefix}] ${line}`);
        if (entry.logs.length > MAX_LOG_LINES) entry.logs.shift();
      }
    };

    append('swarm', `starting: ${command}`);

    try {
      const child = spawn(command, {
        shell: true,
        detached: true,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      entry.child = child;
      entry.pid = child.pid ?? null;

      child.stdout?.on('data', (d) => append('out', d));
      child.stderr?.on('data', (d) => append('err', d));
      child.on('error', (err) => {
        entry.lastError = err.message;
        append('error', err.message);
      });
      child.on('exit', (code, signal) => {
        entry.exitCode = code ?? null;
        entry.startedAt = null;
        entry.child = null;
        entry.pid = null;
        append('swarm', `exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
      });
    } catch (err) {
      entry.lastError = err instanceof Error ? err.message : String(err);
      entry.child = null;
      entry.pid = null;
      entry.startedAt = null;
      append('error', entry.lastError);
    }

    return this.status(backend);
  }

  stop(backend: string, signal: NodeJS.Signals = 'SIGTERM'): RuntimeState {
    const entry = this.entries.get(backend);
    if (entry) this.signal(entry, signal);
    // Best-effort: if this was a named `docker run`, stop the container directly
    // too — covers detached (`-d`) containers the signal above can't reach.
    this.stopNamedDockerContainer(entry);
    return this.status(backend);
  }

  async stopAndWait(
    backend: string,
    signal: NodeJS.Signals = 'SIGTERM',
    timeoutMs = 5000,
  ): Promise<RuntimeState> {
    const entry = this.entries.get(backend);
    if (!this.isRunning(entry)) {
      this.stopNamedDockerContainer(entry);
      return this.status(backend);
    }

    const child = entry.child!;
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });
    this.signal(entry, signal);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          if (this.isRunning(entry)) this.signal(entry, 'SIGKILL');
          resolve();
        }, timeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    this.stopNamedDockerContainer(entry);
    return this.status(backend);
  }

  stopAll(): void {
    for (const backend of this.entries.keys()) {
      this.stop(backend, 'SIGTERM');
    }
  }
}
