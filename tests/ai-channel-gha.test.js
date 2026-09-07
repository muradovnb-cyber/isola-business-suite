const assert = require('assert');
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'AI_CHANNEL_GHA.md');
const content = fs.readFileSync(filePath, 'utf8');
const expected = 'GitHub Actions orchestrator operational.';

assert.strictEqual(content, expected, 'AI_CHANNEL_GHA.md content does not match expected string');

console.log('✓ AI_CHANNEL_GHA.md content verification passed');
