/**
 * Stream-separated exec for `forge infra`'s MACHINE-READ commands.
 *
 * The shared `run()` helper merges stdout+stderr — right for logs, WRONG for parsing: the first
 * live bootstrap read a gcloud stderr WARNING line as a folder id and handed it to
 * `projects create --folder=…`. Any value the CLI parses comes through here, from STDOUT ONLY.
 */
import { spawn } from 'node:child_process';

export interface CaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function capture(command: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          p.kill('SIGKILL');
          reject(new Error(`${command} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
