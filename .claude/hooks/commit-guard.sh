#!/usr/bin/env bash
# PreToolUse hook: veto specific destructive Bash commands.
# jq is not installed on this machine (verified: `command -v jq` found nothing),
# so the JSON payload is parsed with node, which is present in this repo's
# toolchain already, instead of a hand-rolled shell/grep parse of JSON.
set -euo pipefail

# 1. Read the JSON payload the harness pipes on stdin.
payload="$(cat)"

# 2. Pull out .tool_input.command and decide.
command="$(node -e '
  let data = "";
  process.stdin.on("data", chunk => { data += chunk; });
  process.stdin.on("end", () => {
    try {
      const envelope = JSON.parse(data);
      process.stdout.write(envelope.tool_input && envelope.tool_input.command ? envelope.tool_input.command : "");
    } catch (e) {
      process.stdout.write("");
    }
  });
' <<< "$payload")"

if [[ "$command" == *"git push --force"* ]] || [[ "$command" == *"rm -rf /"* ]]; then
  echo "commit-guard: blocked — command matches a forbidden pattern (git push --force / rm -rf /)" >&2
  exit 2
fi

# 3. Otherwise exit 0.
exit 0
