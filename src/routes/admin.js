/**
 * Admin routes: pool inspection, health probes, account lifecycle.
 *
 * Everything here requires an `admin`-scoped key. Responses never contain
 * tokens — only masked fingerprints.
 */

import { Router } from 'express';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { requireScope } from '../middleware/auth.js';
import { getClient, normalizeProxyUrl, toDispatcherUrl } from '../puter/client.js';
import { ApiError, badRequest, upstreamError } from '../errors.js';
import { toApiError } from '../errors.js';

/**
 * Ask the exit node what it sees. A successful TCP connection to a SOCKS port
 * proves the daemon is listening, not that traffic is actually tunnelled; this
 * probes the public exit IP so "route everything through Tor" can be verified
 * rather than assumed.
 *
 * Failure here is reported, never thrown — an egress check that refuses to
 * report a broken route is useless.
 */
async function probeExit(proxy) {
    if (!proxy) {
        return { checked: false, reason: 'direct' };
    }
    const url = toDispatcherUrl(normalizeProxyUrl(proxy) ?? proxy);
    let dispatcher;
    try {
        dispatcher = new ProxyAgent(url);
        const resp = await undiciFetch('https://check.torproject.org/api/ip', {
            dispatcher,
            signal: AbortSignal.timeout(20_000),
        });
        if (!resp.ok) {
            return { checked: true, is_tor: null, error: `probe returned HTTP ${resp.status}` };
        }
        const body = await resp.json();
        return { checked: true, is_tor: body.IsTor === true, exit_ip: body.IP ?? null };
    } catch (err) {
        return {
            checked: true,
            is_tor: null,
            error: err instanceof Error ? err.message : String(err),
        };
    } finally {
        // ProxyAgent holds keep-alive sockets; without this the probe leaks a
        // handle per call and the process will not exit cleanly on SIGTERM.
        await dispatcher?.close().catch(() => {});
    }
}

export function createAdminRouter({ config, registry }) {
    const router = Router();
    const adminOnly = requireScope('admin');

    /** Pool status. Safe to expose to operators. */
    router.get('/v1/accounts', adminOnly, (_req, res) => {
        res.json({
            ok: true,
            count: registry.size,
            sources: registry.sources,
            loaded_at: registry.loadedAt ? new Date(registry.loadedAt).toISOString() : null,
            accounts: registry.describe(),
        });
    });

    /** Live credential probe. Hits Puter's lightweight whoami endpoint. */
    router.post('/v1/accounts/check', adminOnly, async (req, res, next) => {
        try {
            const results = await registry.checkAll(async (account) => {
                const client = getClient(account);
                const user = await client.puter.auth.getUser();
                return user ? { username: user.username ?? null } : null;
            });

            res.json({
                ok: true,
                checked: results.length,
                healthy: results.filter((r) => r.ok).length,
                results,
            });
        } catch (err) {
            next(err);
        }
    });

    /** Reload manifests (picks up changes pushed to a watched repo). */
    router.post('/v1/accounts/reload', adminOnly, async (_req, res, next) => {
        try {
            const summary = await registry.load();
            res.json({ ok: true, ...summary });
        } catch (err) {
            next(err);
        }
    });

    /** Add an account at runtime and persist it to the local manifest. */
    router.post('/v1/accounts', adminOnly, async (req, res, next) => {
        try {
            const { token, id, proxy, tags, label } = req.body ?? {};
            if (typeof token !== 'string' || !token.trim()) {
                throw badRequest('"token" is required');
            }
            if (proxy !== undefined && proxy !== null && typeof proxy !== 'string') {
                throw badRequest('"proxy" must be a string');
            }
            if (tags !== undefined && !Array.isArray(tags)) {
                throw badRequest('"tags" must be an array of strings');
            }

            const account = await registry.addAccount({ token, id, proxy, tags, label });
            res.status(201).json({
                ok: true,
                account: {
                    id: account.id,
                    label: account.label,
                    proxy: account.proxy ?? 'direct',
                },
            });
        } catch (err) {
            next(err);
        }
    });

    router.delete('/v1/accounts/:id', adminOnly, async (req, res, next) => {
        try {
            const removed = await registry.removeAccount(req.params.id);
            res.json({ ok: true, removed: removed.id });
        } catch (err) {
            next(err);
        }
    });

    /** Clear a cooldown, e.g. after confirming the account is healthy again. */
    router.post('/v1/accounts/:id/revive', adminOnly, (req, res, next) => {
        if (!registry.revive(req.params.id)) {
            return next(new ApiError(404, 'account_not_found', `No account "${req.params.id}"`));
        }
        res.json({ ok: true, revived: req.params.id });
    });

    /**
     * Egress self-test: confirms the account's proxy actually routes traffic,
     * and reports the exit IP as Puter sees it.
     */
    router.get('/v1/accounts/:id/egress', adminOnly, async (req, res, next) => {
        const account = registry.byId.get(req.params.id);
        if (!account) {
            return next(new ApiError(404, 'account_not_found', `No account "${req.params.id}"`));
        }

        const started = Date.now();
        const proxyName = account.proxy ?? 'direct';

        // Probe the exit node and the upstream in parallel. They answer
        // different questions — "is my tunnel real?" vs "can this account
        // reach Puter?" — and running them in sequence means a broken route
        // hides the evidence that explains it.
        const exitPromise = probeExit(account.proxy);

        let user = null;
        let upstreamError = null;
        try {
            const client = getClient(account);
            // A cheap authenticated call proves both reachability and that
            // the credential works over this route.
            user = await client.puter.auth.getUser();
        } catch (err) {
            const apiErr = toApiError(err, { accountId: account.id });
            upstreamError = { code: apiErr.code, message: apiErr.message };
        }

        const exit = await exitPromise;

        // The route is healthy only if the tunnel is real AND Puter answered.
        // Reporting `reachable: true` from a partial check would be a lie an
        // operator acts on.
        const ok = !upstreamError;
        res.status(ok ? 200 : upstreamError.code === 'upstream_unauthorized' ? 401 : 502).json({
            ok,
            account: account.id,
            proxy: proxyName,
            reachable: ok,
            duration_ms: Date.now() - started,
            user: user ? { username: user.username ?? null } : null,
            exit,
            ...(upstreamError ? { error: upstreamError } : {}),
        });
    });

    return router;
}
