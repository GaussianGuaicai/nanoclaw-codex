#!/usr/bin/env bash
set -euo pipefail

# Static smoke checks for add-imessage skill package.
# No real iMessage/BlueBubbles credentials required.

node scripts/smoke-add-imessage-skill.mjs
npm run typecheck
