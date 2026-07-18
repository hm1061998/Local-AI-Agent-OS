import { spawn } from 'node:child_process';
import { lstat, realpath, mkdir, writeFile, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
export type Runtime = 'typescript' | 'python';
export type Severity = 'low' | 'medium' | 'high' | 'forbidden';
export interface Finding {
  rule: string;
  severity: Severity;
  file: string;
  line: number;
  message: string;
}
export interface PackageSpec {
  runtime: Runtime;
  files: Record<string, string>;
  dependencies: Record<string, string>;
  scripts?: Record<string, string>;
  lockfile?: string;
  checksums?: Record<string, string>;
  outputSchema?: Record<string, unknown>;
}
export interface SandboxRequest {
  executionId: string;
  taskId: string;
  runtime: Runtime;
  skillDir: string;
  inputDir: string;
  outputDir: string;
  tempDir: string;
  workspaceRead?: string;
  workspaceWrite?: string;
  timeoutMs?: number;
  memoryMb?: number;
  cpus?: number;
  pids?: number;
}
export const dependencyPolicy = {
  version: '2026-07-18',
  node: new Set(['zod', 'date-fns', 'lodash-es', 'fast-glob', 'yaml']),
  python: new Set(['pydantic', 'python-dateutil', 'pyyaml']),
};
const rules: {
  runtime?: Runtime;
  pattern: RegExp;
  rule: string;
  severity: Severity;
  message: string;
}[] = [
  {
    runtime: 'typescript',
    pattern: /\b(child_process|eval\s*\(|new\s+Function|node:net|node:dgram)\b/,
    rule: 'TS_DANGEROUS_API',
    severity: 'forbidden',
    message: 'Dangerous host API is forbidden',
  },
  {
    runtime: 'typescript',
    pattern: /process\.env(?:\b|\[)/,
    rule: 'TS_UNRESTRICTED_ENV',
    severity: 'high',
    message: 'Environment access must use the SDK allowlist',
  },
  {
    runtime: 'typescript',
    pattern: /\b(fetch\s*\(|node:https?|WebSocket\s*\()/,
    rule: 'TS_NETWORK_API',
    severity: 'forbidden',
    message: 'Network APIs are forbidden by default',
  },
  {
    runtime: 'typescript',
    pattern: /\b(node:fs|from\s+['"]fs|require\(['"]fs)/,
    rule: 'TS_RAW_FS',
    severity: 'high',
    message: 'Filesystem access must use SkillWorkspace',
  },
  {
    runtime: 'python',
    pattern: /\b(subprocess|os\.system|eval\s*\(|exec\s*\(|socket|pickle\.loads|requests\.)/,
    rule: 'PY_DANGEROUS_API',
    severity: 'forbidden',
    message: 'Dangerous Python API is forbidden',
  },
  {
    runtime: 'python',
    pattern: /os\.environ|getenv\s*\(/,
    rule: 'PY_UNRESTRICTED_ENV',
    severity: 'high',
    message: 'Environment access must use the SDK allowlist',
  },
  {
    runtime: 'python',
    pattern: /\b(urllib|http\.client|aiohttp|httpx)\b/,
    rule: 'PY_NETWORK_API',
    severity: 'forbidden',
    message: 'Network APIs are forbidden by default',
  },
  {
    pattern: /\.\.\//,
    rule: 'PATH_TRAVERSAL',
    severity: 'forbidden',
    message: 'Parent path traversal is forbidden',
  },
  {
    pattern: /[;&|`]\s*(?:curl|wget|sh|bash|powershell|cmd)\b/,
    rule: 'COMMAND_INJECTION',
    severity: 'forbidden',
    message: 'Shell metacharacters are forbidden',
  },
];
export function scanSource(spec: PackageSpec): Finding[] {
  const findings: Finding[] = [];
  for (const [file, source] of Object.entries(spec.files)) {
    for (const rule of rules) {
      if (rule.runtime && rule.runtime !== spec.runtime) continue;
      source.split(/\r?\n/).forEach((line, index) => {
        if (rule.pattern.test(line))
          findings.push({
            rule: rule.rule,
            severity: rule.severity,
            file,
            line: index + 1,
            message: rule.message,
          });
      });
    }
  }
  return findings;
}
export function validatePackage(spec: PackageSpec) {
  const findings = scanSource(spec);
  if (!spec.lockfile)
    findings.push({
      rule: 'LOCKFILE_REQUIRED',
      severity: 'forbidden',
      file: '',
      line: 0,
      message: 'Exact lockfile is required',
    });
  if (spec.scripts && Object.keys(spec.scripts).some((name) => /^(pre|post)?install$/.test(name)))
    findings.push({
      rule: 'LIFECYCLE_SCRIPT',
      severity: 'forbidden',
      file: 'package.json',
      line: 0,
      message: 'Package lifecycle scripts are forbidden',
    });
  const allowed = spec.runtime === 'typescript' ? dependencyPolicy.node : dependencyPolicy.python;
  for (const [name, version] of Object.entries(spec.dependencies)) {
    if (!allowed.has(name))
      findings.push({
        rule: 'DEPENDENCY_DENIED',
        severity: 'forbidden',
        file: '',
        line: 0,
        message: `${name} is not allowlisted`,
      });
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) || /^(?:git|https?|file):/.test(version))
      findings.push({
        rule: 'DEPENDENCY_NOT_PINNED',
        severity: 'forbidden',
        file: '',
        line: 0,
        message: `${name} must use an exact version`,
      });
  }
  for (const [file, source] of Object.entries(spec.files)) {
    const actual = createHash('sha256').update(source).digest('hex');
    if (spec.checksums?.[file] !== actual)
      findings.push({
        rule: 'CHECKSUM_INVALID',
        severity: 'forbidden',
        file,
        line: 0,
        message: 'Source checksum is missing or invalid',
      });
  }
  return findings;
}
export function compilerFindings(spec: PackageSpec): Finding[] {
  if (spec.runtime !== 'typescript') return [];
  const findings: Finding[] = [];
  for (const [file, source] of Object.entries(spec.files)) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const result = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        strict: true,
      },
      fileName: file,
      reportDiagnostics: true,
    });
    for (const diagnostic of result.diagnostics ?? []) {
      const position =
        diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
          : undefined;
      findings.push({
        rule: 'TS_COMPILER',
        severity: 'forbidden',
        file,
        line: (position?.line ?? -1) + 1,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
      });
    }
  }
  return findings;
}
export function validateJsonOutput(schema: Record<string, unknown> | undefined, value: unknown) {
  if (!schema) return true;
  if (
    schema.type === 'object' &&
    (typeof value !== 'object' || value === null || Array.isArray(value))
  )
    return false;
  const required = Array.isArray(schema.required) ? schema.required : [];
  return required.every(
    (key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(value, key),
  );
}
export function packageHash(spec: PackageSpec) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        runtime: spec.runtime,
        files: Object.entries(spec.files).sort(),
        dependencies: Object.entries(spec.dependencies).sort(),
        lockfile: spec.lockfile,
      }),
    )
    .digest('hex');
}
export async function materializePackage(
  root: string,
  executionId: string,
  spec: PackageSpec,
  input: unknown,
) {
  if (validatePackage(spec).some((item) => item.severity === 'forbidden'))
    throw new Error('PACKAGE_FORBIDDEN');
  const executionRoot = resolve(root, executionId),
    skillDir = resolve(executionRoot, 'skill'),
    inputDir = resolve(executionRoot, 'input'),
    outputDir = resolve(executionRoot, 'output'),
    tempDir = resolve(executionRoot, 'temp');
  await Promise.all([
    mkdir(skillDir, { recursive: true }),
    mkdir(inputDir, { recursive: true }),
    mkdir(outputDir, { recursive: true }),
    mkdir(tempDir, { recursive: true }),
  ]);
  for (const [file, content] of Object.entries(spec.files)) {
    const target = normalizeWorkspacePath(skillDir, file);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  await writeFile(resolve(inputDir, 'input.json'), JSON.stringify(input), 'utf8');
  if (spec.lockfile)
    await writeFile(
      resolve(skillDir, spec.runtime === 'typescript' ? 'yarn.lock' : 'requirements.lock'),
      spec.lockfile,
      'utf8',
    );
  return {
    executionId,
    taskId: 'sandbox',
    runtime: spec.runtime,
    skillDir,
    inputDir,
    outputDir,
    tempDir,
  } satisfies SandboxRequest;
}
export function normalizeWorkspacePath(root: string, input: string) {
  if (!input || isAbsolute(input) || input.split(/[\\/]+/).includes('..') || /[\0\r\n]/.test(input))
    throw new Error('WORKSPACE_ACCESS_DENIED');
  const target = resolve(root, input);
  if (target !== resolve(root) && !target.startsWith(resolve(root) + sep))
    throw new Error('WORKSPACE_ACCESS_DENIED');
  return target;
}
export async function assertNoSymlinkEscape(root: string, input: string) {
  const target = normalizeWorkspacePath(root, input);
  const rootReal = await realpath(root);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error('SYMLINK_FORBIDDEN');
    const targetReal = await realpath(target);
    if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep))
      throw new Error('SYMLINK_ESCAPE');
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      return;
    throw error;
  }
  return target;
}
export function dockerArguments(r: SandboxRequest) {
  const image =
    r.runtime === 'typescript'
      ? 'local-agent-skill-node:phase3'
      : 'local-agent-skill-python:phase3';
  const args = [
    'run',
    '--rm',
    '--name',
    `local-agent-${r.executionId}`,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(r.pids ?? 64),
    '--memory',
    `${r.memoryMb ?? 256}m`,
    '--memory-swap',
    `${r.memoryMb ?? 256}m`,
    '--cpus',
    String(r.cpus ?? 0.5),
    '--ulimit',
    'nofile=256:256',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--mount',
    `type=bind,src=${resolve(r.skillDir)},dst=/skill,readonly`,
    '--mount',
    `type=bind,src=${resolve(r.inputDir)},dst=/input,readonly`,
    '--mount',
    `type=bind,src=${resolve(r.outputDir)},dst=/output`,
  ];
  if (r.workspaceRead)
    args.push('--mount', `type=bind,src=${resolve(r.workspaceRead)},dst=/workspace-read,readonly`);
  if (r.workspaceWrite)
    args.push('--mount', `type=bind,src=${resolve(r.workspaceWrite)},dst=/workspace-write`);
  args.push(image);
  return args;
}
export class DockerSandboxRunner {
  private running = new Map<string, ReturnType<typeof spawn>>();
  async execute(request: SandboxRequest) {
    const args = dockerArguments(request);
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (done, reject) => {
        const child = spawn('docker', args, {
          shell: false,
          env: { PATH: process.env.PATH ?? '' },
        });
        this.running.set(request.executionId, child);
        let stdout = '',
          stderr = '';
        const timer = setTimeout(() => {
          void this.kill(request.executionId);
        }, request.timeoutMs ?? 30_000);
        child.stdout.on('data', (data) => (stdout += String(data)));
        child.stderr.on('data', (data) => (stderr += String(data)));
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(timer);
          this.running.delete(request.executionId);
          done({ code, stdout, stderr });
        });
      },
    );
  }
  async kill(id: string) {
    this.running.get(id)?.kill('SIGKILL');
    await new Promise<void>((done) => {
      const child = spawn('docker', ['kill', `local-agent-${id}`], { shell: false });
      child.on('close', () => done());
      child.on('error', () => done());
    });
  }
}
export function relativeStagedPath(root: string, target: string) {
  const value = relative(resolve(root), resolve(target));
  if (value.startsWith('..') || isAbsolute(value)) throw new Error('STAGING_ESCAPE');
  return value.replaceAll('\\', '/');
}
export interface StagedChange {
  path: string;
  before: string | null;
  after: string;
  kind: 'create' | 'modify';
}
export function assertStagingPath(path: string) {
  const normalized = path.replaceAll('\\', '/');
  if (
    !/^(tests|src|\.local-agent\/output)\/[a-zA-Z0-9._/-]+$/.test(normalized) ||
    normalized.includes('../') ||
    normalized.includes('/..')
  )
    throw new Error('STAGING_PATH_DENIED');
  return normalized;
}
export async function previewStagedChanges(
  workspace: string,
  files: Record<string, string>,
): Promise<StagedChange[]> {
  const changes: StagedChange[] = [];
  for (const [path, after] of Object.entries(files)) {
    const safe = assertStagingPath(path),
      target = normalizeWorkspacePath(workspace, safe);
    await assertNoSymlinkEscape(workspace, safe);
    let before: string | null = null;
    try {
      before = await readFile(target, 'utf8');
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ))
        throw error;
    }
    if (before !== after)
      changes.push({ path: safe, before, after, kind: before === null ? 'create' : 'modify' });
  }
  return changes;
}
export async function applyStagedChanges(workspace: string, changes: StagedChange[]) {
  const applied: StagedChange[] = [];
  try {
    for (const change of changes) {
      const safe = assertStagingPath(change.path),
        target = normalizeWorkspacePath(workspace, safe);
      await assertNoSymlinkEscape(workspace, safe);
      await mkdir(resolve(target, '..'), { recursive: true });
      const temporary = `${target}.local-agent-${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, change.after, 'utf8');
      await rename(temporary, target);
      applied.push(change);
    }
    return applied;
  } catch (error) {
    await rollbackStagedChanges(workspace, applied);
    throw error;
  }
}
export async function rollbackStagedChanges(workspace: string, changes: StagedChange[]) {
  for (const change of [...changes].reverse()) {
    const target = normalizeWorkspacePath(workspace, assertStagingPath(change.path));
    if (change.before === null) {
      try {
        await unlink(target);
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ))
          throw error;
      }
    } else {
      const temporary = `${target}.local-agent-${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, change.before, 'utf8');
      await rename(temporary, target);
    }
  }
}
