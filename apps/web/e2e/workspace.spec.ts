import { expect, test, type Page } from '@playwright/test';

const now = '2026-07-18T00:00:00.000Z';
const task = {
  id: 'task-1',
  title: 'Create report',
  userInput: 'Create report',
  state: 'executing',
  createdAt: now,
  updatedAt: now,
};

async function mockApi(page: Page) {
  await page.route('**/api/models/health', (route) =>
    route.fulfill({
      json: {
        available: false,
        baseUrl: 'http://127.0.0.1:11434',
        chatModel: 'deepseek-r1',
        chatModelAvailable: false,
        embedModel: 'nomic-embed-text',
        embedModelAvailable: false,
        message: 'Không thể kết nối Ollama.',
      },
    }),
  );
  await page.route('**/api/tasks', async (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ json: task })
      : route.fulfill({ json: [] }),
  );
  await page.route('**/api/tasks/task-1', (route) => route.fulfill({ json: task }));
  await page.route('**/api/tasks/task-1/events', (route) =>
    route.fulfill({
      json: [
        {
          id: 'event-1',
          taskId: 'task-1',
          type: 'TASK_RECEIVED',
          state: 'idle',
          message: 'Đã nhận tác vụ.',
          timestamp: now,
          sequence: 1,
        },
        {
          id: 'event-2',
          taskId: 'task-1',
          type: 'EXECUTION_STARTED',
          state: 'executing',
          message: 'Bắt đầu thực thi.',
          timestamp: now,
          sequence: 2,
        },
      ],
    }),
  );
  await page.route('**/api/tasks/task-1/cancel', (route) =>
    route.fulfill({ json: { accepted: true } }),
  );
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test('submits a task and displays its timeline', async ({ page }) => {
  await page.goto('/workspace');
  await page.getByLabel('Yêu cầu').fill('Create report');
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page).toHaveURL(/\/tasks\/task-1/);
  await expect(page.getByTestId('execution-trace')).toContainText('Đã nhận tác vụ.');
  await expect(page.getByTestId('execution-trace')).toContainText('Bắt đầu thực thi.');
});

test('sends task cancellation', async ({ page }) => {
  let cancelled = false;
  await page.route('**/api/tasks/task-1/cancel', (route) => {
    cancelled = true;
    return route.fulfill({ json: { accepted: true } });
  });
  await page.goto('/tasks/task-1');
  await page.getByRole('button', { name: 'Cancel task' }).click();
  await expect.poll(() => cancelled).toBe(true);
});

test('shows model unavailable guidance', async ({ page }) => {
  await page.goto('/settings/models');
  await expect(page.getByText('Không thể kết nối Ollama.')).toBeVisible();
  await expect(page.getByText('ollama pull deepseek-r1')).toBeVisible();
});

test('approval center approves a declarative skill proposal', async ({ page }) => {
  let status = 'pending';
  const approval = () => ({
    id: 'approval-1',
    status,
    proposal: {
      name: 'json-normalizer',
      reason: 'Missing normalization capability',
      runtimeType: 'prompt',
      riskLevel: 'low',
      permissions: {
        filesystem: { read: [], write: [], delete: [] },
        commands: [],
        network: { enabled: false, allowedHosts: [] },
        environmentVariables: [],
      },
    },
  });
  await page.route('**/api/approvals', (route) => route.fulfill({ json: [approval()] }));
  await page.route('**/api/approvals/approval-1/approve', (route) => {
    status = 'approved';
    return route.fulfill({ json: { approval: approval() } });
  });
  await page.goto('/approvals');
  await expect(page.getByText('json-normalizer')).toBeVisible();
  await page.getByRole('button', { name: 'Approve version' }).click();
  await expect.poll(() => status).toBe('approved');
});

test('skill studio lists active declarative skills', async ({ page }) => {
  await page.route('**/api/skills', (route) =>
    route.fulfill({
      json: [
        {
          id: 'json-normalizer',
          name: 'JSON Normalizer',
          version: '1.0.0',
          status: 'active',
          manifest: { runtime: { type: 'prompt' } },
        },
      ],
    }),
  );
  await page.goto('/skills');
  await expect(page.getByRole('heading', { name: 'Skill Studio' })).toBeVisible();
  await expect(page.getByText('JSON Normalizer')).toBeVisible();
  await expect(page.getByText('active')).toBeVisible();
});

test('task waiting for a generated skill links to approval center', async ({ page }) => {
  await page.route('**/api/tasks/task-1', (route) =>
    route.fulfill({ json: { ...task, state: 'waiting_for_approval' } }),
  );
  await page.goto('/tasks/task-1');
  await expect(page.getByTestId('task-state')).toHaveText('waiting_for_approval');
  await expect(page.getByRole('link', { name: /Review skill proposal/ })).toHaveAttribute(
    'href',
    '/approvals',
  );
});

test('sandbox review exposes findings and kill control', async ({ page }) => {
  await page.route('**/api/sandbox/executions', (route) =>
    route.fulfill({
      json: [
        {
          id: 'exec-1',
          skillId: 'test-generator',
          runtime: 'typescript',
          status: 'running',
          findings: [{ rule: 'TS_RAW_FS', severity: 'high' }],
          stdout: 'tests passed',
        },
      ],
    }),
  );
  await page.route('**/api/sandbox/executions/exec-1/kill', (route) =>
    route.fulfill({ json: { accepted: true } }),
  );
  await page.goto('/sandbox');
  await expect(page.getByRole('heading', { name: 'Executable Sandbox' })).toBeVisible();
  await expect(page.getByText('TS_RAW_FS')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kill sandbox' })).toBeVisible();
});

test('sandbox UI scans, approves, runs, and displays persisted output', async ({ page }) => {
  let status = 'waiting_for_approval';
  let output: unknown;
  const execution = () => ({
    id: 'exec-demo',
    skillId: 'hello-sandbox',
    runtime: 'typescript',
    status,
    findings: [],
    output,
  });
  await page.route('**/api/sandbox/executions', (route) =>
    route.fulfill({ json: status === 'none' ? [] : [execution()] }),
  );
  await page.route('**/api/sandbox/scan', (route) => {
    status = 'waiting_for_approval';
    return route.fulfill({ json: execution() });
  });
  await page.route('**/api/sandbox/executions/exec-demo/approve', (route) => {
    status = 'approved';
    return route.fulfill({ json: { accepted: true } });
  });
  await page.route('**/api/sandbox/executions/exec-demo/run', (route) => {
    status = 'completed';
    output = { message: 'Hello Minh', input: { name: 'Minh' } };
    return route.fulfill({ json: { status, output } });
  });
  status = 'none';
  await page.goto('/sandbox');
  await page.getByRole('button', { name: 'Scan package' }).click();
  await expect(page.getByRole('button', { name: 'Approve version' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve version' }).click();
  await expect(page.getByRole('button', { name: 'Run sandbox' })).toBeVisible();
  await page.getByRole('button', { name: 'Run sandbox' }).click();
  await expect(page.getByTestId('sandbox-output')).toContainText('Hello Minh');
});

test('sandbox UI previews, applies, and rolls back staged files', async ({ page }) => {
  let status = 'waiting_for_changes_approval';
  const staged = [
    {
      path: 'tests/generated.test.ts',
      kind: 'create',
      before: null,
      after: 'test("generated",()=>expect(true).toBe(true))',
    },
  ];
  const execution = () => ({
    id: 'exec-diff',
    skillId: 'test-generator',
    runtime: 'typescript',
    status,
    findings: [],
    output: { files: { 'tests/generated.test.ts': staged[0].after } },
    staged,
    applied: status === 'changes_applied' ? staged : undefined,
  });
  await page.route('**/api/sandbox/executions', (route) => route.fulfill({ json: [execution()] }));
  await page.route('**/api/sandbox/executions/exec-diff/apply', (route) => {
    status = 'changes_applied';
    return route.fulfill({ json: { applied: staged } });
  });
  await page.route('**/api/sandbox/executions/exec-diff/rollback', (route) => {
    status = 'changes_rolled_back';
    return route.fulfill({ json: { rolledBack: true } });
  });
  await page.goto('/sandbox');
  await expect(page.getByText('Staged diff')).toBeVisible();
  await page.getByRole('button', { name: 'Apply approved changes' }).click();
  await expect(page.getByRole('button', { name: 'Rollback changes' })).toBeVisible();
  await page.getByRole('button', { name: 'Rollback changes' }).click();
  await expect(page.getByText('changes_rolled_back')).toBeVisible();
});

test('universe renders registry, falls back to 2D, searches and disables a skill', async ({
  page,
}) => {
  let disabled = false;
  const skill = {
    id: 'code-analyzer',
    name: 'Code Analyzer',
    status: 'active',
    usageCount: 8,
    successRate: 0.9,
    createdBy: 'system',
    manifest: { runtime: { type: 'typescript' }, riskLevel: 'low' },
  };
  await page.route('**/api/skills', (route) => route.fulfill({ json: [skill] }));
  await page.route('**/api/telemetry', (route) =>
    route.fulfill({
      json: {
        cpu: { load: 1 },
        ram: { used: 50, total: 100 },
        gpu: { available: false },
        ollama: { chatModel: 'deepseek-r1' },
      },
    }),
  );
  await page.route('**/api/skills/code-analyzer/disable', (route) => {
    disabled = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/universe');
  await expect(page.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Use 2D' }).click();
  await expect(page.getByRole('img', { name: /Skill graph/ })).toBeVisible();
  await page.getByLabel('Search skill').fill('Code');
  await page.getByRole('button', { name: /Code Analyzer/ }).click();
  await expect(page.getByRole('heading', { name: 'Code Analyzer' })).toBeVisible();
  await page.getByRole('button', { name: 'Disable' }).click();
  await expect.poll(() => disabled).toBe(true);
});

test('execution inspector replays persisted events without executing skills', async ({ page }) => {
  await page.route('**/api/tasks/task-1', (route) =>
    route.fulfill({ json: { ...task, state: 'completed' } }),
  );
  await page.route('**/api/tasks/task-1/events', (route) =>
    route.fulfill({
      json: [
        {
          id: 'a',
          taskId: 'task-1',
          type: 'TASK_RECEIVED',
          state: 'idle',
          message: 'received',
          timestamp: now,
          sequence: 1,
        },
        {
          id: 'b',
          taskId: 'task-1',
          type: 'TASK_COMPLETED',
          state: 'completed',
          message: 'done',
          timestamp: now,
          sequence: 2,
        },
      ],
    }),
  );
  await page.route('**/api/sandbox/executions', (route) => route.fulfill({ json: [] }));
  await page.goto('/tasks/task-1/inspect');
  await page.getByRole('button', { name: 'Step forward' }).click();
  await expect(page.getByText('received')).toBeVisible();
  await page.getByRole('button', { name: 'Step forward' }).click();
  await expect(page.getByText('done')).toBeVisible();
  await page.getByRole('button', { name: 'Step backward' }).click();
  await expect(page.getByText('done')).not.toBeVisible();
});

test('workflow editor validates and saves a declarative workflow', async ({ page }) => {
  let saved = false;
  await page.route('**/api/skills', (route) =>
    route.fulfill({
      json: [
        {
          id: 'reader',
          name: 'Reader',
          status: 'active',
          manifest: { runtime: { type: 'prompt' } },
        },
      ],
    }),
  );
  await page.route('**/api/workflows', (route) => {
    saved = true;
    return route.fulfill({ json: { id: 'new-workflow' } });
  });
  await page.goto('/workflows/new');
  await page.getByRole('button', { name: 'Reader' }).click();
  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page.getByText(/dry run passed/)).toBeVisible();
  await page.getByRole('button', { name: 'Save workflow' }).click();
  await expect.poll(() => saved).toBe(true);
});
