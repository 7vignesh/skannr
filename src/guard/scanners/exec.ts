/**
 * Process execution for scanners. Runs the program directly (no shell), so
 * file names and refs are never interpreted by a shell.
 */

import { spawnSync } from 'child_process';
import type { ExecFn, ExecResult } from './types';

const MAX_BUFFER = 64 * 1024 * 1024;

export const defaultExec: ExecFn = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    encoding: 'utf-8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error as ExecResult['error'],
  };
};

/** Matches ANSI colour codes, built from a string so the escape character is not a literal in a regex. */
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

/** Turn a failed run into a one-line, user-facing reason. */
export function describeFailure(r: ExecResult): string {
  if (r.error?.code === 'ENOENT') return 'not installed';
  if (r.error?.code === 'ETIMEDOUT') return 'timed out';
  if (r.error) return r.error.message.split('\n')[0];
  const firstLine = r.stderr.replace(ANSI, '').split('\n').find((l) => l.trim()) ?? '';
  return `exited with status ${r.status}${firstLine ? `: ${firstLine.trim().slice(0, 200)}` : ''}`;
}
