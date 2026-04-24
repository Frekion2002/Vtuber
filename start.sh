#!/bin/bash
# Airi 서비스 일괄 실행: priority-proxy + tamagotchi
# 사용법:   bash ~/Airi/start.sh  (또는 ~/Airi/start.sh)
# 종료:    Ctrl+C  (두 프로세스 다 정리됨)
#
# 로그는 [proxy] / [tama] 접두사로 한 터미널에 섞어서 출력.

set -u

cleanup() {
  echo ""
  echo "[start] Shutting down..."
  pkill -f priority-proxy.ts 2>/dev/null
  pkill -9 -f electron 2>/dev/null
  exit 0
}
trap cleanup INT TERM

# PATH 보강 (non-interactive shell은 ~/.bashrc early-return)
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.local/share/fnm:$PATH"
command -v fnm > /dev/null 2>&1 && eval "$(fnm env --use-on-cd 2>/dev/null)"

# GEMINI_API_KEY 주입
eval "$(grep '^export GEMINI_API_KEY' ~/.bashrc)"
if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "[start] ERROR: GEMINI_API_KEY not found in ~/.bashrc" >&2
  exit 1
fi

# pnpm 존재 확인
if ! command -v pnpm > /dev/null 2>&1; then
  echo "[start] ERROR: pnpm not found in PATH. Run from interactive shell or fix PATH." >&2
  exit 1
fi

# 기존 프로세스 정리 (재실행 안전성)
echo "[start] Cleaning up stale processes..."
pkill -f priority-proxy.ts 2>/dev/null
pkill -9 -f electron 2>/dev/null
sleep 2

# Proxy 시작
echo "[start] Starting proxy..."
(
  cd "$HOME/Airi/proxy"
  exec "$HOME/.bun/bin/bun" run priority-proxy.ts 2>&1
) | sed -u 's/^/[proxy] /' &

# Proxy 포트 바인드 대기 (최대 ~8초)
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -s http://localhost:3100/health > /dev/null 2>&1; then
    echo "[start] Proxy ready on :3100"
    break
  fi
  sleep 0.5
done

# Tamagotchi 시작
echo "[start] Starting tamagotchi..."
(
  cd "$HOME/Airi/airi"
  exec pnpm dev:tamagotchi 2>&1
) | sed -u 's/^/[tama]  /' &

echo ""
echo "[start] All services up. Logs interleaved with [proxy]/[tama] prefix."
echo "[start] Ctrl+C to stop both."
echo ""

# 백그라운드 자식 모두 대기. Ctrl+C 들어오면 trap INT → cleanup.
wait
cleanup
