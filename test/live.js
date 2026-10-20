/**
 * Local smoke test harness. Runs the mock Puter upstream on a fixed port and
 * the real server as a child process, exactly like `npm start`, so the
 * documented curl commands can be exercised end to end.
 *
 *   node test/live.js
 */

import { spawn } from 'node:child_process';
import { createMockPuter } from './mock-puter.js';

const MOCK_PORT = 9099;
const APP_PORT = 8080;

const mock = createMockPuter();

// The mock picks a random port by default; pin it for the child process.
mock.server.listen(MOCK_PORT, '127.0.0.1', async () => {
    process.stdout.write(`mock upstream on http://127.0.0.1:${MOCK_PORT}\n`);

    const child = spawn(
        process.execPath,
        ['src/index.js'],
        {
            stdio: 'inherit',
            env: {
                ...process.env,
                PORT: String(APP_PORT),
                HOST: '127.0.0.1',
                PUTER_API_ORIGIN: `http://127.0.0.1:${MOCK_PORT}`,
                NODE_ENV: 'development',
            },
        },
    );

    const stop = () => {
        child.kill('SIGTERM');
        mock.server.close(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    child.on('exit', (code) => {
        process.stdout.write(`proxy exited with ${code}\n`);
        mock.server.close(() => process.exit(0));
    });
});
