# Player-agent protocol fixtures

These JSON documents are compatibility fixtures for the additive player-agent protocol. They are
examples, not credentials or user configuration. Protocol version 1 remains the registration and
fallback launch baseline; a version-2-capable agent advertises `[1, 2]` and uses the version selected
by the add-on.

The fixtures are consumed by both the add-on's Node tests and the Windows agent's dependency-free
contract test harness. Changing a field intentionally therefore requires updating both sides in the
same pull request. In particular:

- `registration-v1.json` represents an already-released protocol-v1 agent.
- `registration-v2-capable.json` is the current additive registration payload.
- `session-create-v2.json`, `session-control-v2.json`, and `session-status-v2.json` lock the
  shared v2 session wire names and millisecond units.
- `health-v1-v2.json`, `info-v2.json`, and `info-v2-linux.json` lock discovery responses for
  the Windows and Linux implementations.

Both platforms advertise the shared `players.list`, `sessions.create`, `sessions.status`,
`sessions.control`, and `sessions.end-reasons` surface and accept the canonical
`POST /v2/sessions/{id}/control` request. Ended sessions remain queryable briefly so clients can
distinguish natural player exit, explicit stop, and replacement without guessing from a transport
failure.

All IDs, paths, names, and the all-zero test key are synthetic.
