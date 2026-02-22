# Changelog

## [0.2.4] - 2026-02-25

### Changed
- Feedback is now updatable — resubmitting on the same entry updates in place (no more DUPLICATE_FEEDBACK error)
- Response includes `previousOutcome` field when updating existing feedback
- SYNC_VERSION updated to `2026-02-25-v1`

## [0.2.3] - 2026-02-21

### Added
- Full self-documenting `--help` for all subcommands with examples and tips
- Search flags: `--min-quality`, `--max-tokens`, `--context-os`, `--context-shell`, `--context-tools`
- Contribute flags: `--problem`, `--solution`, `--error-messages`, `--failed-approaches`, `--lang`, `--framework`, `--environment`, `--effort-tokens`, `--effort-duration`, `--effort-tools`, `--ttl`
- Feedback flags: `--correction-content`, `--correction-title`, `--correction-tags`, `--correction-id`
- `claim` and `verify` commands for agent claiming
- SYNC_VERSION marker for cross-repo sync tracking
