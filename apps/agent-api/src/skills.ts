import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import type {
  ExecutionPlan,
  SkillManifest,
  SkillRoutingResult,
  TaskAnalysis,
} from '@local-agent/agent-protocol';
const base = (
  id: string,
  name: string,
  tags: string[],
  capabilities: string[],
  write = false,
  commands: string[] = [],
): SkillManifest => ({
  id,
  name,
  version: '1.0.0',
  description: name,
  tags,
  triggers: tags,
  runtime: { type: 'typescript', timeoutSeconds: 30 },
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  permissions: {
    filesystem: { read: ['**/*'], write: write ? ['.local-agent/output/*'] : [], delete: [] },
    commands,
    network: { enabled: false, allowedHosts: [] },
    environmentVariables: [],
  },
  riskLevel: commands.length ? 'medium' : 'low',
  approvalRequired: false,
  capabilities,
});
export const manifests = [
  base('filesystem-reader', 'Filesystem Reader', ['read', 'file'], ['filesystem:read']),
  base('filesystem-search', 'Filesystem Search', ['search', 'find'], ['filesystem:search']),
  base('code-analyzer', 'Code Analyzer', ['code', 'analyze'], ['code:analyze']),
  base(
    'unit-test-generator',
    'Unit Test Generator',
    ['test', 'generate'],
    ['testing:generate'],
    true,
  ),
  base('test-runner', 'Test Runner', ['test', 'run'], ['testing:run'], false, [
    'yarn test',
    'npm test',
    'npx vitest run',
    'npx jest --runInBand',
  ]),
  base('markdown-report', 'Markdown Report', ['report', 'markdown'], ['reporting'], true),
  base(
    'pdf-generator',
    'PDF Generator',
    ['pdf', 'export', 'document'],
    ['document:pdf'],
    true,
  ),
  base(
    'artifact-generator',
    'Artifact Generator',
    ['export', 'document', 'spreadsheet', 'csv', 'json', 'html', 'svg'],
    [
      'document:docx',
      'spreadsheet:xlsx',
      'data:csv',
      'data:json',
      'document:html',
      'document:markdown',
      'document:text',
      'image:svg',
    ],
    true,
  ),
];
export function safePath(workspace: string, input: string) {
  const root = resolve(workspace);
  const target = resolve(root, input);
  if (target !== root && !target.startsWith(root + sep)) throw new Error('WORKSPACE_ACCESS_DENIED');
  return target;
}
export const allowedCommands = new Set([
  'yarn test',
  'npm test',
  'npx vitest run',
  'npx jest --runInBand',
]);
export function assertAllowedCommand(command: string) {
  if (!allowedCommands.has(command)) throw new Error('WORKSPACE_ACCESS_DENIED');
  return command.split(' ');
}
export function routeSkills(analysis: TaskAnalysis): SkillRoutingResult {
  const terms = new Set([
    ...analysis.requiredCapabilities,
    analysis.category,
    ...analysis.intent.toLowerCase().split(/\W+/),
  ]);
  const candidates = manifests
    .map((s) => {
      const reasons: string[] = [];
      let score = 0;
      for (const c of s.capabilities)
        if (terms.has(c)) {
          score += 5;
          reasons.push(`capability: ${c}`);
        }
      for (const tag of s.tags)
        if (terms.has(tag)) {
          score += 2;
          reasons.push(`tag: ${tag}`);
        }
      return { skillId: s.id, score, reasons };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  const selectedSkillIds = candidates.slice(0, 3).map((c) => c.skillId);
  const covered = new Set(
    selectedSkillIds.flatMap((id) => manifests.find((s) => s.id === id)?.capabilities ?? []),
  );
  const missingCapabilities = analysis.requiredCapabilities.filter((c) => !covered.has(c));
  return {
    candidates,
    selectedSkillIds,
    confidence: candidates[0] ? Math.min(1, candidates[0].score / 7) : 0,
    missingCapabilities,
  };
}
export function inferFilesystemPath(input: string) {
  const normalized = input.replace(/\\/g, '/');
  const quoted = [...normalized.matchAll(/["'`](.+?\.[a-z0-9]{1,12})["'`]/gi)].at(-1)?.[1];
  const match = normalized.match(
    /(?:^|\s)((?:[a-z]:\/)?[^\s"'`<>|:*?]*[a-z0-9_.-]+\.[a-z0-9]{1,12})(?=\s|$|[),.;:!?])/i,
  );
  const file = (quoted ?? match?.[1])?.replace(/^\.\//, '');
  if (!file) return '.';
  if (file.includes('/')) return file;
  const folder = [
    ...normalized.matchAll(
      /(?:trong\s+(?:thư\s+mục|folder|directory)|in\s+(?:the\s+)?(?:folder|directory))\s+["'`]?([a-z0-9._/-]+)/giu,
    ),
  ].at(-1)?.[1];
  return folder ? `${folder.replace(/^\.\//, '').replace(/\/$/, '')}/${file}` : file;
}

export function createPlan(
  analysis: TaskAnalysis,
  routing: SkillRoutingResult,
  originalInput = '',
): ExecutionPlan {
  const selected = routing.selectedSkillIds.length
    ? routing.selectedSkillIds.slice(0, 1)
    : ['markdown-report'];
  return {
    goal: analysis.intent,
    steps: selected.map((skillId, index) => ({
      id: `step-${index + 1}`,
      order: index + 1,
      title: `Thực thi ${skillId}`,
      description: `Dùng ${skillId} để đáp ứng tác vụ`,
      skillId,
      input: {
        path:
          skillId === 'filesystem-reader' || skillId === 'code-analyzer'
            ? inferFilesystemPath(originalInput)
            : '.',
      },
      expectedOutput: 'Kết quả có cấu trúc',
      risk: manifests.find((s) => s.id === skillId)?.riskLevel === 'medium' ? 'medium' : 'low',
    })),
  };
}
export function validatePlan(plan: ExecutionPlan, maxSteps: number) {
  if (plan.steps.length > maxSteps) throw new Error('BUDGET_EXCEEDED');
  const ids = new Set(manifests.map((s) => s.id));
  const orders = new Set<number>();
  for (const step of plan.steps) {
    if (!ids.has(step.skillId) || orders.has(step.order)) throw new Error('PLAN_INVALID');
    orders.add(step.order);
  }
  return plan;
}
export async function executeSkill(
  id: string,
  input: Record<string, unknown>,
  workspace: string,
  signal: AbortSignal,
) {
  if (signal.aborted) throw new Error('TASK_CANCELLED');
  const path = String(input.path ?? '.');
  if (id === 'filesystem-reader')
    return { content: await readFile(safePath(workspace, path), 'utf8') };
  if (id === 'filesystem-search') {
    const entries = await readdir(safePath(workspace, path));
    return { entries };
  }
  if (id === 'code-analyzer') {
    const target = safePath(workspace, path);
    const info = await stat(target);
    return {
      path: relative(workspace, target),
      kind: info.isDirectory() ? 'directory' : 'file',
      extension: extname(target),
    };
  }
  if (id === 'markdown-report' || id === 'unit-test-generator') {
    const dir = safePath(workspace, '.local-agent/output');
    await mkdir(dir, { recursive: true });
    const file = resolve(dir, `${id}-${Date.now()}.md`);
    await writeFile(file, `# ${id}\n\nGenerated safely by Local Agent OS.\n`);
    return { file: relative(workspace, file) };
  }
  if (id === 'pdf-generator') {
    const source = String(input.source ?? input.content ?? '');
    if (!source.trim()) throw new Error('PDF_SOURCE_MISSING');
    const requested = String(input.sourcePath ?? 'document').replace(/[^a-z0-9._-]+/gi, '-');
    const basename = requested.replace(/\.[^.]+$/, '') || 'document';
    const dir = safePath(workspace, '.local-agent/output');
    await mkdir(dir, { recursive: true });
    const file = resolve(dir, `${basename}.pdf`);
    await writeFile(file, createSimplePdf(source));
    const artifact = relative(workspace, file);
    return {
      file: artifact,
      artifacts: [artifact],
      mimeType: 'application/pdf',
      sourcePath: String(input.sourcePath ?? ''),
      sourceHash: createHash('sha256').update(source).digest('hex'),
    };
  }
  if (id === 'artifact-generator') {
    const source = String(input.source ?? input.content ?? '');
    const extension = String(input.outputExtension ?? '.txt').toLowerCase();
    if (!source.trim()) throw new Error('ARTIFACT_SOURCE_MISSING');
    if (!supportedArtifactExtensions.has(extension)) throw new Error('ARTIFACT_FORMAT_UNSUPPORTED');
    const requested = String(input.sourcePath ?? 'artifact').replace(/[^a-z0-9._-]+/gi, '-');
    const basename = requested.replace(/\.[^.]+$/, '') || 'artifact';
    const dir = safePath(workspace, '.local-agent/output');
    await mkdir(dir, { recursive: true });
    const file = resolve(dir, `${basename}${extension}`);
    await writeFile(file, createArtifact(source, extension));
    const artifact = relative(workspace, file);
    return { file: artifact, artifacts: [artifact], mimeType: artifactMimeType(extension) };
  }
  if (id === 'test-runner') {
    const command = String(input.command ?? 'yarn test');
    const [bin, ...args] = assertAllowedCommand(command);
    return new Promise((resolvePromise, reject) => {
      const child = spawn(bin!, args, { cwd: workspace, shell: false, signal });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (d) => (stdout += String(d)));
      child.stderr.on('data', (d) => (stderr += String(d)));
      child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
      child.on('error', reject);
    });
  }
  throw new Error('SKILL_NOT_FOUND');
}

const supportedArtifactExtensions = new Set([
  '.txt', '.md', '.json', '.csv', '.html', '.svg', '.docx', '.xlsx',
]);

function createArtifact(source: string, extension: string): string | Buffer {
  if (extension === '.json') return JSON.stringify({ content: source }, null, 2);
  if (extension === '.csv') return source.split(/\r?\n/).map((line) => `"${line.replace(/"/g, '""')}"`).join('\n');
  if (extension === '.html') return `<!doctype html><html><meta charset="utf-8"><body><pre>${escapeHtml(source)}</pre></body></html>`;
  if (extension === '.svg') return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="100%" height="100%" fill="white"/><text x="48" y="72" font-family="Arial" font-size="24" fill="black">${escapeXml(source.slice(0, 800))}</text></svg>`;
  if (extension === '.docx') return createDocx(source);
  if (extension === '.xlsx') return createXlsx(source);
  return source;
}

function createDocx(source: string): Buffer {
  const paragraphs = source.split(/\r?\n/).map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`).join('');
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`),
  }));
}

function createXlsx(source: string): Buffer {
  const rows = source.split(/\r?\n/).map((line, index) => `<row r="${index + 1}"><c r="A${index + 1}" t="inlineStr"><is><t>${escapeXml(line)}</t></is></c></row>`).join('');
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`),
  }));
}

function escapeXml(value: string) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function escapeHtml(value: string) { return escapeXml(value); }
function artifactMimeType(extension: string) {
  return ({ '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv', '.html': 'text/html', '.svg': 'image/svg+xml', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } as Record<string, string>)[extension] ?? 'application/octet-stream';
}

/** A dependency-free, deterministic PDF writer for plain text artifacts. */
function createSimplePdf(text: string): Buffer {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .flatMap((line) => line.match(/.{1,88}(?:\s|$)|\S+?(?:\s|$)/g) ?? [''])
    .map((line) => line.replace(/[()\\]/g, '\\$&').replace(/[^\x20-\x7e]/g, '?').trimEnd());
  const pages = Array.from({ length: Math.max(1, Math.ceil(lines.length / 52)) }, (_, page) =>
    lines.slice(page * 52, (page + 1) * 52),
  );
  const pageIds = pages.map((_, index) => 4 + index * 2);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pages.forEach((pageLines, pageIndex) => {
    const commands = pageLines
      .map((line, lineIndex) => `BT /F1 ${pageIndex === 0 && lineIndex === 0 ? 16 : 11} Tf 54 ${790 - lineIndex * 14} Td (${line}) Tj ET`)
      .join('\n');
    const pageId = pageIds[pageIndex]!;
    const contentId = pageId + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(commands, 'ascii')} >>\nstream\n${commands}\nendstream`,
    );
  });
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf, 'ascii')); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'ascii');
}
