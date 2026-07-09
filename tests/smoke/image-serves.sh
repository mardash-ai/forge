#!/usr/bin/env bash
# P21 GUARD (runtime half) — prove the BUILT images actually boot + serve, not just that source does.
#
# Background: the 0.26.x control-plane image was reported "Running but its API never reachable at
# :3717," while the SAME code ran fine from source (`tsx src/api/server.ts` over the full node_modules).
# A source-only test can never catch that class — the failure lives in the built image's dependency
# tree / install, not in the code. So this builds each image the way it actually ships and probes
# `/health` from INSIDE the container (exactly how the co-located CLI dials it), asserting HTTP 200.
#
# Run locally:  bash tests/smoke/image-serves.sh
# In CI:        the `image-smoke` workflow runs it on every PR / push to main.
set -euo pipefail

cd "$(dirname "$0")/../.."

PLATFORM="${SMOKE_PLATFORM:-linux/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')}"
CP_IMAGE="forge-control-plane:smoke-$$"
DP_IMAGE="forge-data-plane:smoke-$$"
CP_NAME="forge-cp-smoke-$$"
DP_NAME="forge-dp-smoke-$$"

cleanup() {
  docker rm -f "$CP_NAME" "$DP_NAME" >/dev/null 2>&1 || true
  docker rmi "$CP_IMAGE" "$DP_IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Probe an already-running container's in-container /health on $port. Retries so a cold boot (tsx
# transpiles the graph on first start) doesn't flake. Fails the script if it never returns 200.
probe() {
  local name="$1" port="$2" label="$3"
  local code=""
  for _ in $(seq 1 45); do
    # State guard: if the process crashed at boot the container will have exited — surface it now
    # rather than waiting out the whole loop.
    local status
    status="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo missing)"
    if [ "$status" = "exited" ] || [ "$status" = "dead" ]; then
      echo "FAIL: $label container is $status before serving :$port"
      docker logs "$name" 2>&1 | tail -20
      exit 1
    fi
    code="$(docker exec "$name" node -e "fetch('http://127.0.0.1:$port/health').then(r=>{process.stdout.write(String(r.status))}).catch(()=>{process.stdout.write('000')})" 2>/dev/null || echo 000)"
    if [ "$code" = "200" ]; then
      echo "PASS: $label built image serves :$port/health -> 200"
      return 0
    fi
    sleep 1
  done
  echo "FAIL: $label built image never served :$port/health (last code=$code)"
  docker logs "$name" 2>&1 | tail -20
  exit 1
}

echo "== P21 image-serves smoke ($PLATFORM) =="

echo "-- build + run CONTROL PLANE --"
docker build --platform "$PLATFORM" -t "$CP_IMAGE" -f Dockerfile . >/dev/null
docker run -d --name "$CP_NAME" --platform "$PLATFORM" "$CP_IMAGE" >/dev/null
probe "$CP_NAME" 3717 "control-plane"

echo "-- build + run DATA PLANE --"
docker build --platform "$PLATFORM" -t "$DP_IMAGE" -f Dockerfile.data-plane . >/dev/null
docker run -d --name "$DP_NAME" --platform "$PLATFORM" -e FORGE_APP_NAME=smoke "$DP_IMAGE" >/dev/null
probe "$DP_NAME" 3718 "data-plane"

echo "== all images serve =="
