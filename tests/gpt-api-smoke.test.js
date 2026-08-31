/*
 * Smoke test for gpt-api bridge.
 * Spawns scripts/gpt-api-smoke.sh and verifies output and exit code.
 * Uses only Node built-ins (assert) — no test framework needed.
 */
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');

(async () => {
  try {
    console.log('\n=== GPT API SMOKE TEST ===');

    const scriptPath = path.join(__dirname, '..', 'scripts', 'gpt-api-smoke.sh');

    const result = await new Promise((resolve, reject) => {
      const child = spawn('bash', [scriptPath]);
      let output = '';
      let errorOutput = '';

      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      child.on('close', (code) => {
        resolve({ output: output.trim(), errorOutput, code });
      });

      child.on('error', (err) => {
        reject(err);
      });
    });

    // Assert the output is 'gpt-api-e2e-ok'
    assert.strictEqual(
      result.output,
      'gpt-api-e2e-ok',
      `Expected output to be 'gpt-api-e2e-ok', but got '${result.output}'`
    );
    console.log('  ✔ Output matches expected: gpt-api-e2e-ok');

    // Assert the exit code is 0
    assert.strictEqual(
      result.code,
      0,
      `Expected exit code to be 0, but got ${result.code}`
    );
    console.log('  ✔ Exit code is 0');

    console.log('\n' + '='.repeat(50));
    console.log('RESULTS: 2/2 passed, 0 failed');
    process.exitCode = 0;
  } catch (e) {
    console.error('TEST ERROR:', e.message);
    process.exitCode = 1;
  }
})();
