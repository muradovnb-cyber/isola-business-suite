const fs = require('fs');
const path = require('path');
const assert = require('assert');

describe('AI_CHANNEL_GHA.md', () => {
  it('should contain the expected content', () => {
    const filePath = path.join(__dirname, '..', 'AI_CHANNEL_GHA.md');
    const content = fs.readFileSync(filePath, 'utf8');
    const expectedContent = 'GitHub Actions orchestrator operational.';

    assert.strictEqual(content, expectedContent,
      `Expected content to be "${expectedContent}" but got "${content}"`);
  });
});
