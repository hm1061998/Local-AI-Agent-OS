import { spawn } from 'node:child_process';

export type ToolStatus = 'available' | 'missing' | 'installed' | 'disabled' | 'failed';
export interface ManagedTool {
  id: string;
  capability: string;
  executable: string;
  packageName: string;
  install: string[];
}

/** A deliberately small allow-list: task text can never become a shell command. */
export const managedTools: ManagedTool[] = [
  {
    id: 'playwright',
    capability: 'browser:automation',
    executable: 'playwright',
    packageName: '@playwright/test',
    install: ['yarn', 'add', '-D', '@playwright/test'],
  },
  {
    id: 'typescript',
    capability: 'code:typescript',
    executable: 'tsc',
    packageName: 'typescript',
    install: ['yarn', 'add', '-D', 'typescript'],
  },
  {
    id: 'python',
    capability: 'code:python',
    executable: 'python',
    packageName: 'python',
    install: [],
  },
];

function run(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

export class ToolInstaller {
  constructor(
    private readonly workspace = process.env.AGENT_WORKSPACE ?? process.cwd(),
    private readonly enabled = process.env.AGENT_AUTO_INSTALL_TOOLS !== 'false',
  ) {}
  async status(tool: ManagedTool): Promise<ToolStatus> {
    try {
      return (await run(tool.executable, ['--version'], this.workspace)) === 0
        ? 'available'
        : 'missing';
    } catch {
      return 'missing';
    }
  }
  async ensureCapabilities(capabilities: string[]) {
    const requested = managedTools.filter((tool) =>
      capabilities.some((value) => value.toLowerCase() === tool.capability),
    );
    return Promise.all(requested.map((tool) => this.ensure(tool)));
  }
  async ensure(tool: ManagedTool) {
    const before = await this.status(tool);
    if (before === 'available') return { tool, status: before };
    if (!this.enabled || tool.install.length === 0) {
      const status: ToolStatus = this.enabled ? 'failed' : 'disabled';
      return { tool, status };
    }
    const [command, ...args] = tool.install;
    if (!command) return { tool, status: 'failed' as ToolStatus };
    try {
      const status: ToolStatus =
        (await run(command, args, this.workspace)) === 0 ? 'installed' : 'failed';
      return { tool, status };
    } catch {
      return { tool, status: 'failed' as ToolStatus };
    }
  }
}
