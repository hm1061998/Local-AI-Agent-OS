import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dockerArguments,
  normalizeWorkspacePath,
  relativeStagedPath,
  scanSource,
  validatePackage,
  validateJsonOutput,
  compilerFindings,
  previewStagedChanges,
  applyStagedChanges,
  rollbackStagedChanges,
} from '../src/index';
const spec = (files: Record<string, string> = {}, dependencies: Record<string, string> = {}) => ({
  runtime: 'typescript' as const,
  files,
  dependencies,
  lockfile: 'yarn.lock',
});
describe('Phase 3 security policy', () => {
  it('blocks path traversal', () =>
    expect(() => normalizeWorkspacePath('C:\\work', '../secret')).toThrow(
      'WORKSPACE_ACCESS_DENIED',
    ));
  it('blocks absolute paths', () =>
    expect(() => normalizeWorkspacePath('C:\\work', 'C:\\Users\\x')).toThrow(
      'WORKSPACE_ACCESS_DENIED',
    ));
  it('blocks command injection', () =>
    expect(scanSource(spec({ 'src/a.ts': 'run; curl evil' }))[0]?.rule).toBe('COMMAND_INJECTION'));
  it('blocks child processes', () =>
    expect(scanSource(spec({ 'src/a.ts': "import x from 'child_process'" }))[0]?.severity).toBe(
      'forbidden',
    ));
  it('blocks eval', () =>
    expect(scanSource(spec({ 'src/a.ts': 'eval(input)' }))).not.toHaveLength(0));
  it('blocks raw filesystem', () =>
    expect(scanSource(spec({ 'src/a.ts': "import fs from 'node:fs'" }))[0]?.rule).toBe(
      'TS_RAW_FS',
    ));
  it('blocks unrestricted environment', () =>
    expect(scanSource(spec({ 'src/a.ts': 'process.env.SECRET' }))[0]?.rule).toBe(
      'TS_UNRESTRICTED_ENV',
    ));
  it('blocks Node and Python network APIs', () => {
    expect(scanSource(spec({ 'src/a.ts': "fetch('https://example.com')" }))[0]?.rule).toBe(
      'TS_NETWORK_API',
    );
    expect(
      scanSource({
        runtime: 'python',
        files: { 'a.py': 'import urllib' },
        dependencies: {},
        lockfile: 'x',
      })[0]?.rule,
    ).toBe('PY_NETWORK_API');
  });
  it('uses the TypeScript compiler to reject syntax errors', () =>
    expect(compilerFindings(spec({ 'src/a.ts': 'export const broken = ;' }))[0]?.rule).toBe(
      'TS_COMPILER',
    ));
  it('blocks Python network and subprocess', () =>
    expect(
      scanSource({
        runtime: 'python',
        files: { 'a.py': 'import subprocess\nimport socket' },
        dependencies: {},
        lockfile: 'requirements.lock',
      }).every((x) => x.severity === 'forbidden'),
    ).toBe(true));
  it('requires a lockfile', () =>
    expect(validatePackage({ runtime: 'typescript', files: {}, dependencies: {} })[0]?.rule).toBe(
      'LOCKFILE_REQUIRED',
    ));
  it('blocks dependencies outside allowlist', () =>
    expect(validatePackage(spec({}, { 'left-pad': '1.0.0' }))[0]?.rule).toBe('DEPENDENCY_DENIED'));
  it('requires exact dependency versions', () =>
    expect(validatePackage(spec({}, { zod: '^4.1.0' }))[0]?.rule).toBe('DEPENDENCY_NOT_PINNED'));
  it('blocks lifecycle scripts', () =>
    expect(validatePackage({ ...spec(), scripts: { postinstall: 'curl evil' } })[0]?.rule).toBe(
      'LIFECYCLE_SCRIPT',
    ));
  it('keeps staging paths inside root', () =>
    expect(() => relativeStagedPath('C:\\stage', 'C:\\secret')).toThrow('STAGING_ESCAPE'));
  it('disables network and privileges in Docker', () => {
    const args = dockerArguments({
      executionId: 'x',
      taskId: 't',
      runtime: 'typescript',
      skillDir: 'skill',
      inputDir: 'input',
      outputDir: 'output',
      tempDir: 'tmp',
    });
    expect(args).toContain('none');
    expect(args).toContain('ALL');
    expect(args).toContain('no-new-privileges');
    expect(args).not.toContain('/var/run/docker.sock');
  });
  it('uses tokenized Docker arguments without a shell', () =>
    expect(
      dockerArguments({
        executionId: 'x',
        taskId: 't',
        runtime: 'python',
        skillDir: 'skill',
        inputDir: 'input',
        outputDir: 'output',
        tempDir: 'tmp',
      })[0],
    ).toBe('run'));
  it('rejects invalid output schema', () =>
    expect(validateJsonOutput({ type: 'object', required: ['result'] }, { ok: true })).toBe(false));
  it('requires source checksums', () =>
    expect(
      validatePackage(spec({ 'src/a.ts': 'export{}' })).some(
        (item) => item.rule === 'CHECKSUM_INVALID',
      ),
    ).toBe(true));
  it('previews, atomically applies, and rolls back staged changes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-stage-'));
    const changes = await previewStagedChanges(workspace, {
      'tests/generated.test.ts': 'export const ok=true;',
    });
    expect(changes[0]).toMatchObject({ kind: 'create' });
    await applyStagedChanges(workspace, changes);
    expect(await readFile(join(workspace, 'tests/generated.test.ts'), 'utf8')).toContain('ok=true');
    await rollbackStagedChanges(workspace, changes);
    await expect(
      readFile(join(workspace, 'tests/generated.test.ts'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('denies staged writes outside explicit workspace folders', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-stage-'));
    await expect(previewStagedChanges(workspace, { 'package.json': '{}' })).rejects.toThrow(
      'STAGING_PATH_DENIED',
    );
  });
});
