# Changelog

All notable changes to Breaker are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Breaker uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — 2026-09-07

First release. Three switches, on a timer.

### Added

- **Tab switch.** The background watches `chrome.webRequest.onErrorOccurred` and
  keeps a per-tab ledger of requests that failed in a DNS-shaped way
  (`ERR_ADDRESS_INVALID` from Pi-hole's default NULL blocking mode, plus the
  NXDOMAIN/refused/unreachable shapes the other blocking modes produce). The popup
  lists them by frequency; "Allow selected" / "Allow all" adds exact-match allow
  entries scoped to this device's group only, so the rest of the network stays
  filtered.
- **Device switch.** Moves this machine's Pi-hole client entry out of the Default
  group and into its own `Breaker: <host>` group, which carries no blocklists.
  The previous membership is recorded and restored — including any groups the user
  assigned by hand.
- **Network switch.** `POST /api/dns/blocking` with a timer. Pi-hole owns the
  countdown, so the reset survives the browser being closed.
- **Cross-check.** Asks Pi-hole's query log which of a tab's failures Pi-hole
  actually caused, and marks each host blocked / not-Pi-hole / unseen. If the tab
  has failures but Pi-hole saw no queries at all from this device, the popup warns
  that Chrome's Secure DNS (DoH) is probably bypassing Pi-hole — in which case none
  of the switches can work.
- **Expiry.** Every timed grant gets a `chrome.alarms` alarm, and a sweep runs on
  service-worker start and every 10 minutes. Deadlines are written into the Pi-hole
  entry's own comment as well as into extension storage, so a grant made by a
  browser that never comes back is still cleaned up.
- **Pi-hole v6 gate.** The Core version is read at connect time and anything below
  v6 is refused by name. v5's API is entirely different; there is no partial
  support to fall back to.
- Options page that reports the address Pi-hole resolved for this machine, whether
  it found a MAC, and which group and client entry Breaker is using — the state
  that decides whether the device and tab switches can work at all.
- `scripts/live-check.mjs`, an integration check against a real Pi-hole that
  restores everything it touches.

### Known limits

See the README's "What Breaker cannot do". In short: server-side inserted ads
(YouTube, Twitch, Spotify) are not DNS-blockable and Breaker cannot bring them
back or remove them; Chrome's Secure DNS bypasses Pi-hole entirely; and the device
and tab switches need Pi-hole to see this machine directly rather than through a
VPN or a second router.
