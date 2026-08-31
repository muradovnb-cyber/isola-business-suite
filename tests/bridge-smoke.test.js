const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

// Path to the shell script
const scriptPath = path.join(__dirname, '..', 'scripts', 'bridge-smoke.sh');

// Spawn the shell script
const result = spawnSync('bash', [scriptPath], { encoding: 'utf-8' });

// Assert that the output is 'bridge-v2-ok\n'
assert.strictEqual(result.stdout, 'bridge-v2-ok\n', 'Output should be "bridge-v2-ok\\n"');

// Assert that the exit code is 0
assert.strictEqual(result.status, 0, 'Exit code should be 0');

console.log('✓ Bridge v2.0 smoke test passed');
