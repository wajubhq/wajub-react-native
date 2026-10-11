# Changelog

## 1.4.1

- `watchStatus()` reports the payment's status again when realtime is on. The SDK subscribed to a
  channel named after your own reference, while Wajub publishes on the payment's id: the socket
  connected, the polling stopped, and no update ever arrived. It now subscribes on the payment's
  id (`transaction.id`).
- Polling no longer stops when the socket connects. It runs for the whole watch, so a status the
  socket did not carry (one that changed before the subscription, or a missed event) still
  reaches your callback within `intervalMs`. With realtime on, the callback is called when the
  result changes, not on every poll, and a final result stops the polling.

Releases before 1.4.1 are described in the Git history.
