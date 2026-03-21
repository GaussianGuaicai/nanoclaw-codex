# Remove Qodo checklist

This repository appears to have standardized on Codex for code generation and PR review.

Use this checklist to remove any remaining Qodo-related repository integration that may still exist outside tracked files:

- Uninstall any Qodo or PR-Agent GitHub App installation for this repository.
- Remove any Qodo-related required status checks from branch protection.
- Delete any Qodo-only repository secrets or organization secrets still referenced by this repository.
- Remove any Qodo review workflow files if they are introduced later.
- Confirm a new pull request can merge without Qodo checks or comments.

This document is intentionally repository-focused. It does not change runtime behavior.
