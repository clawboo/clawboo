#!/bin/sh
# A stand-in for an agent runtime: says who it runs as and whether it can read
# Clawboo's private files, as one JSON line. Paths arrive in the environment.
probe() {
  if [ -z "$1" ]; then echo '"unset"'; return; fi
  if err=$(cat "$1" 2>&1 >/dev/null); then echo '"readable"'; else
    case "$err" in *"Permission denied"*) echo '"EACCES"' ;; *) echo '"other"' ;; esac
  fi
}
list() {
  if ls "$1" >/dev/null 2>&1; then echo '"listed"'; else echo '"EACCES"'; fi
}
printf '{"uid":%s,"db":%s,"key":%s,"vault":%s,"dataList":%s,"cwd":"%s"}\n' \
  "$(id -u)" "$(probe "$PROOF_DB")" "$(probe "$PROOF_KEY")" "$(probe "$PROOF_VAULT")" \
  "$(list "$PROOF_DATA")" "$(pwd)"
