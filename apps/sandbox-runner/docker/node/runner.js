const fs = require('node:fs');
(async () => {
  try {
    const input = JSON.parse(fs.readFileSync('/input/input.json', 'utf8'));
    const skill = require('/skill/dist/index.js');
    if (typeof skill.run !== 'function') throw new Error('SKILL_RUN_MISSING');
    const output = await skill.run(input);
    fs.writeFileSync('/output/output.json', JSON.stringify(output));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  }
})();
