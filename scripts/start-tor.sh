#!/usr/bin/env bash
#
# Start a Tor SOCKS5 daemon on 9050, or verify the one already running.
#
# The proxy speaks SOCKS5 but ships no onion router, so `PUTER_PROXY=tor` does
# nothing until a daemon is listening. Starting one from an interactive shell
# is a trap: it dies with the shell, and the symptom (every account cooling down
# at once) looks nothing like "my daemon is gone".
#
# Usage:
#   ./scripts/start-tor.sh            # start or report status
#   ./scripts/start-tor.sh --verify   # also confirm traffic exits Tor

set -euo pipefail

PORT="${TOR_SOCKS_PORT:-9050}"
DATA_DIR="${TOR_DATA_DIR:-$HOME/.tor-puter-proxy}"

find_tor() {
    if command -v tor >/dev/null 2>&1; then
        command -v tor
        return 0
    fi
    # Tor Browser bundles a full daemon; useful when brew/apt is unavailable.
    local bundled="/Applications/Tor Browser.app/Contents/MacOS/Tor/tor"
    if [ -x "$bundled" ]; then
        echo "$bundled"
        return 0
    fi
    return 1
}

port_open() {
    if command -v lsof >/dev/null 2>&1; then
        lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1
    else
        (exec 3<>"/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1
    fi
}

verify() {
    echo "Verifying exit route on port $PORT ..."
    local out
    if out=$(curl -s --max-time 60 --socks5-hostname "127.0.0.1:$PORT" \
        https://check.torproject.org/api/ip 2>/dev/null); then
        echo "  $out"
        case "$out" in
            *'"IsTor":true'*|*'"IsTor": true'*)
                echo "OK: traffic exits through Tor."
                return 0
                ;;
            *)
                echo "WARNING: reachable, but the exit is not Tor." >&2
                return 1
                ;;
        esac
    fi
    echo "FAILED: no response via SOCKS5. Tor may still be bootstrapping." >&2
    return 1
}

if port_open; then
    echo "Tor is already listening on 127.0.0.1:$PORT."
    [ "${1:-}" = "--verify" ] && verify
    exit 0
fi

TOR_BIN=$(find_tor) || {
    echo "No tor binary found. Install it:" >&2
    echo "  macOS:  brew install tor" >&2
    echo "  Debian: sudo apt-get install -y tor" >&2
    exit 1
}

mkdir -p "$DATA_DIR"
echo "Starting $TOR_BIN on port $PORT (data: $DATA_DIR)"

# setsid/nohup detach the daemon so it survives the calling shell. Without a
# supervisor it still dies on reboot — use brew services or systemd for that.
if command -v setsid >/dev/null 2>&1; then
    setsid "$TOR_BIN" --SocksPort "$PORT" --DataDirectory "$DATA_DIR" \
        --Log "notice file $DATA_DIR/tor.log" >/dev/null 2>&1 &
else
    nohup "$TOR_BIN" --SocksPort "$PORT" --DataDirectory "$DATA_DIR" \
        --Log "notice file $DATA_DIR/tor.log" >/dev/null 2>&1 &
fi

echo -n "Waiting for bootstrap"
for _ in $(seq 1 60); do
    if port_open; then
        echo " — listening."
        [ "${1:-}" = "--verify" ] && verify
        exit 0
    fi
    echo -n "."
    sleep 1
done

echo ""
echo "Timed out after 60s. Last log lines:" >&2
tail -5 "$DATA_DIR/tor.log" >&2 2>/dev/null || true
exit 1
