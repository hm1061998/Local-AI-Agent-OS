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
