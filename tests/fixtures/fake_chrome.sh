#!/bin/sh
# Fake Chrome stub for tests/proof_helper_test.ts
MODE="${FAKE_CHROME_MODE:-exit_immediately}"

for arg in "$@"; do
  case "$arg" in
    --mode=*)
      MODE="${arg#--mode=}"
      ;;
  esac
done

case "$MODE" in
  exit_immediately)
    exit 0
    ;;
  write_port_and_exit)
    for arg in "$@"; do
      case "$arg" in
        --user-data-dir=*)
          DIR="${arg#--user-data-dir=}"
          mkdir -p "$DIR"
          printf "9222\n/devtools/browser/fake\n" > "$DIR/DevToolsActivePort"
          ;;
      esac
    done
    exit 0
    ;;
  hang)
    sleep 30
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
