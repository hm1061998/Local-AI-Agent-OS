/**
 * Contracts used by the autonomous loop. A capability is never considered
 * complete merely because an LLM described an answer: side-effecting work
 * needs an executable skill and a verifiable artifact or command result.
 */
const executablePrefixes = [
  'filesystem:write',
  'document:',
  'spreadsheet:',
  'image:',
  'browser:',
  'code:modify',
  'testing:run',
  'network:',
];

export function needsExecutableSkill(capability: string) {
  return executablePrefixes.some((prefix) => capability.toLowerCase().startsWith(prefix));
}

export function isSafeOutputCapability(capability: string) {
  return ['document:pdf', 'reporting', 'filesystem:write'].includes(capability.toLowerCase());
}

export function uniqueCapabilities(capabilities: string[]) {
  return [...new Set(capabilities.map((value) => value.trim()).filter(Boolean))];
}
