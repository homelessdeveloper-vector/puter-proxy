// Supervisor shim.
//
// The app runs this instead of src/index.js directly so the server can never
// outlive it. A GUI app that is force-quit or SIGKILLed gets no chance to run
// cleanup, so the child has to notice the parent is gone on its own — otherwise
// the Node server keeps holding the port and the next launch fails with
// "port already in use".
//
// We check two independent signals every second:
//   - process.ppid: reparenting to launchd is instant and unambiguous.
//   - kill(ppid, 0): catches the case where the pid still resolves.

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const parentPid = Number(process.env.PP_PARENT_PID || 0);
const entry = process.env.PP_SERVER_ENTRY;

if (!entry || !existsSync(entry)) {
    console.error(`[launcher] server entry not found: ${entry ?? '(unset)'}`);
    process.exit(1);
}

function orphaned() {
    if (parentPid <= 0) return false;
    if (process.ppid !== parentPid) return true;
    try {
        process.kill(parentPid, 0);
        return false;
    } catch {
        return true;
    }
}

if (parentPid > 0) {
    const watchdog = setInterval(() => {
        if (orphaned()) {
            console.error('[launcher] parent process is gone; exiting');
            process.exit(0);
        }
    }, 1000);
    // Do not let the watchdog alone keep the process alive.
    watchdog.unref();
}

// Import rather than spawn: the server runs in this process, so there is
// exactly one thing to supervise and one thing to kill.
await import(pathToFileURL(entry).href);
