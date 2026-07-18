import { createHash } from 'node:crypto';
import { ApiController, RuntimeService } from '../../agent-api/src/app';

async function main() {
  const source =
    "exports.run = async input => ({ message: 'Hello ' + (input.name || 'world'), input });";
  const file = 'dist/index.js';
  const checksum = createHash('sha256').update(source).digest('hex');
  const api = new ApiController(new RuntimeService());
  const scanned = api.scanExecutable({
    skillId: 'hello-sandbox-demo',
    package: {
      runtime: 'typescript',
      files: { [file]: source },
      dependencies: {},
      lockfile: '# locked',
      checksums: { [file]: checksum },
      outputSchema: { type: 'object', required: ['message'] },
    },
  });
  api.approveSandbox(scanned.id);
  const result = await api.runSandbox(scanned.id, { input: { name: 'Minh' } });
  const saved = api.sandboxExecutions().find((item) => item.id === scanned.id);
  console.log(
    JSON.stringify(
      {
        scanned: scanned.status,
        approvable: scanned.approvable,
        result,
        savedOutput: saved?.output,
      },
      null,
      2,
    ),
  );
}
void main();
