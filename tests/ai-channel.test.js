const fs = require('fs');
const assert = require('assert');
const path = require('path');

// Read the AI_CHANNEL_TEST.md file
const filePath = path.join(__dirname, '..', 'AI_CHANNEL_TEST.md');
const content = fs.readFileSync(filePath, 'utf8');

// Expected content
const expected = 'GPT n8n Claude GitHub channel operational.';

// Verify the content matches exactly
assert.strictEqual(content, expected, 'AI_CHANNEL_TEST.md content does not match expected value');

console.log('✓ AI channel test passed');
