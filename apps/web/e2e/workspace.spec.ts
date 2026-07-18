import { expect, test, type Page } from '@playwright/test';

const now = '2026-07-18T00:00:00.000Z';
const task = { id: 'task-1', title: 'Create report', userInput: 'Create report', state: 'executing', createdAt: now, updatedAt: now };

async function mockApi(page: Page) {
  await page.route('**/api/models/health', (route) => route.fulfill({ json: { available: false, baseUrl: 'http://127.0.0.1:11434', chatModel: 'deepseek-r1', chatModelAvailable: false, embedModel: 'nomic-embed-text', embedModelAvailable: false, message: 'Không thể kết nối Ollama.' } }));
  await page.route('**/api/tasks', async (route) => route.request().method() === 'POST' ? route.fulfill({ json: task }) : route.fulfill({ json: [] }));
  await page.route('**/api/tasks/task-1', (route) => route.fulfill({ json: task }));
  await page.route('**/api/tasks/task-1/events', (route) => route.fulfill({ json: [{ id: 'event-1', taskId: 'task-1', type: 'TASK_RECEIVED', state: 'idle', message: 'Đã nhận tác vụ.', timestamp: now, sequence: 1 }, { id: 'event-2', taskId: 'task-1', type: 'EXECUTION_STARTED', state: 'executing', message: 'Bắt đầu thực thi.', timestamp: now, sequence: 2 }] }));
  await page.route('**/api/tasks/task-1/cancel', (route) => route.fulfill({ json: { accepted: true } }));
}

test.beforeEach(async ({ page }) => { await mockApi(page); });

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
  await page.route('**/api/tasks/task-1/cancel', (route) => { cancelled = true; return route.fulfill({ json: { accepted: true } }); });
  await page.goto('/tasks/task-1');
  await page.getByRole('button', { name: 'Cancel task' }).click();
  await expect.poll(() => cancelled).toBe(true);
});

test('shows model unavailable guidance', async ({ page }) => {
  await page.goto('/settings/models');
  await expect(page.getByText('Không thể kết nối Ollama.')).toBeVisible();
  await expect(page.getByText('ollama pull deepseek-r1')).toBeVisible();
});
