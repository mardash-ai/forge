import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  // If set, all stdout+stderr is teed to this file (append-safe: it is truncated
  // once at the start of the run).
  logFile?: string;
  // Keep the last N lines of combined output in memory for summaries.
  tailLines?: number;
  timeoutMs?: number;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  // Last `tailLines` lines of combined stdout+stderr.
  tail: string[];
  // Full combined output kept in memory only up to a safety cap.
  combined: string;
  timedOut: boolean;
  command: string;
}

const MAX_MEMORY_BYTES = 512 * 1024; // never hold more than 512KB of output in memory

// Run a command, teeing output to a log file and returning a compact tail. This
// is the single choke point for shelling out — Capabilities never spawn directly.
export function run(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const tailLines = opts.tailLines ?? 60;
  const started = Date.now();
  const printable = [command, ...args].join(' ');

  return new Promise((resolve, reject) => {
    const finish = async () => {
      let logStream: ReturnType<typeof createWriteStream> | undefined;
      if (opts.logFile) {
        await mkdir(path.dirname(opts.logFile), { recursive: true });
        logStream = createWriteStream(opts.logFile, { flags: 'w' });
        logStream.write(`$ ${printable}\n`);
      }

      const child = spawn(command, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const tail: string[] = [];
      let combined = '';
      let combinedBytes = 0;
      let timedOut = false;

      const pushChunk = (buf: Buffer) => {
        logStream?.write(buf);
        if (combinedBytes < MAX_MEMORY_BYTES) {
          combined += buf.toString('utf8');
          combinedBytes += buf.length;
        }
        const text = buf.toString('utf8');
        for (const line of text.split('\n')) {
          if (line.length === 0) continue;
          tail.push(line);
          if (tail.length > tailLines) tail.shift();
        }
      };

      child.stdout.on('data', pushChunk);
      child.stderr.on('data', pushChunk);

      let timer: NodeJS.Timeout | undefined;
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs);
      }

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        logStream?.end();
        reject(err);
      });

      child.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        logStream?.end();
        resolve({
          code,
          signal,
          durationMs: Date.now() - started,
          tail,
          combined,
          timedOut,
          command: printable,
        });
      });
    };

    finish().catch(reject);
  });
}

// Convenience: run and resolve with success boolean.
export async function runOk(command: string, args: string[], opts: RunOptions = {}): Promise<boolean> {
  try {
    const r = await run(command, args, opts);
    return r.code === 0;
  } catch {
    return false;
  }
}
