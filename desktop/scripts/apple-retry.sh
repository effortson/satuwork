#!/bin/bash
# Both stapler staple and validate contact Apple's ticket service. CloudKit can
# disconnect even after notarization was accepted or a ticket was stapled.
# Allow just over five minutes of backoff, then preserve the failing exit code.
# Diagnostics go to stderr so callers can still capture spctl's stdout.
retry_apple() {
  local attempt delay=15 status
  for attempt in 1 2 3 4 5 6 7 8; do
    if "$@"; then
      return 0
    else
      status=$?
    fi
    if [ "$attempt" -eq 8 ]; then
      echo "Apple service check failed after $attempt attempts (exit $status)." >&2
      return "$status"
    fi
    echo "Apple service check failed (attempt $attempt/8, exit $status); retrying in ${delay}s." >&2
    sleep "$delay"
    delay=$((delay * 2))
    [ "$delay" -le 60 ] || delay=60
  done
}
