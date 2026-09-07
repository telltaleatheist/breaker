# Breaker

**Trip the ad-blocking breaker for this tab, this device, or your whole network.**

Pi-hole is a light switch: on, or off, for everyone. Breaker is a breaker panel —
one switch per circuit. When a site breaks because Pi-hole ate something it needed,
you trip the smallest breaker that fixes it, and it resets itself on a timer.

Three switches:

| Switch | What it does | Who it affects |
| --- | --- | --- |
| **This page** | Unblocks the specific hostnames Pi-hole blocked on this page | Just this computer |
| **This computer** | Turns Pi-hole off for this computer only | Just this computer |
| **Everyone** | Turns Pi-hole off for the whole network | Everyone in the house |

In the popup, the three read as **Pi-hole is on / off** for this page, this computer,
or everyone — one vocabulary, one idea. Every one of them takes a duration — **10 minutes, 1 hour, 24 hours, or until you
say** — and puts itself back when the time is up. Nothing is left switched off
because you forgot.

Breaker works with **Pi-hole v6 and later**. Pi-hole is the backend it currently
speaks to, not the point of the product; the whole Pi-hole vocabulary lives behind
`src/api/`, so another backend can be added without touching anything else.

---

## Install

Breaker is not in the Chrome Web Store yet, so it installs unpacked.

```bash
git clone https://github.com/telltaleatheist/breaker.git
cd breaker
npm install
npm run build
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → choose the `dist/` folder

`npm run package` instead produces `breaker-0.1.0.zip`, which unzips to a single
`breaker/` folder to point "Load unpacked" at — handy for installing on a machine
that has no toolchain.

## Setup

Breaker opens its options page on first install. You need two things:

**1. Your Pi-hole address.** Whatever you use for the Pi-hole web interface —
`http://pi.hole`, `http://192.168.1.5`, `http://pi.hole:8080`. Pasting the full
admin URL is fine; Breaker trims it down.

**2. An app password.** In Pi-hole: **Settings → Web interface → App password**.

Use an app password rather than your real one. Chrome stores extension settings
unencrypted on disk, so anything with access to your Chrome profile can read what
you put here. An app password is revocable in one click, is not your Pi-hole login,
and is the only thing that works if you have two-factor authentication switched on
(Breaker will tell you so if you try a plain password against a 2FA Pi-hole).

Press **Connect**. You should get something like:

```
Connected to Pi-hole v6.4.3 as 192.168.1.42 (MAC 3c:22:fb:12:34:56)
```

**Read that line.** The address is who Pi-hole thinks you are, and the device and
tab switches only work if it is actually this machine — see
[When the device is not what Pi-hole thinks](#when-the-device-is-not-what-pi-hole-thinks).

### Skip the typing: a preconfigured build

If you build Breaker yourself, you can bake your own Pi-hole address and app
password into the build so it starts connected. Create `breaker.local.json` in the
repo root (it is gitignored):

```json
{ "baseUrl": "http://pi.hole", "password": "your-app-password" }
```

`npm run build` reads it (or the file named by `BREAKER_CONFIG`) and seeds the
extension's settings on its first run. Options can still change them afterwards,
and Disconnect still means disconnect — the baked values are used only when nothing
has ever been saved.

`npm run package` always builds **without** it. A zip meant for other people must
not carry your credentials.

---

## How each switch works

### This tab

Chrome cannot see DNS. What it can see is requests failing, and a DNS block has a
recognisable shape.

Pi-hole's default blocking mode is NULL: a blocked name resolves to `0.0.0.0`, and
Chrome refuses to connect to it — `net::ERR_ADDRESS_INVALID`. Ordinary sites do not
resolve to `0.0.0.0`, so that error is close to diagnostic. The other blocking modes
produce `ERR_NAME_NOT_RESOLVED` (NXDOMAIN mode), or `ERR_CONNECTION_REFUSED` /
`ERR_ADDRESS_UNREACHABLE` (IP mode). Breaker watches for all of them and ignores
everything else — `ERR_ABORTED`, `ERR_BLOCKED_BY_CLIENT`, timeouts — because
offering to allow a domain Pi-hole never touched is a promise it cannot keep.

Those hostnames become the tab's list, busiest first. Tick the ones you need and
press **Allow selected**, or **Allow all**.

An allow becomes an exact-match entry on Pi-hole's allowlist, assigned to **this
device's Breaker group only**. A group-scoped allowlist entry applies to clients in
that group and nobody else, so "allow `doubleclick.net` for ten minutes" unblocks
it for you and leaves the rest of the house filtered. When the timer expires, the
entry is deleted.

**Press Reload afterwards.** Pi-hole stamps blocked answers with a 2-second TTL, so
your browser's cached "this is 0.0.0.0" is stale almost immediately — a reload is
all it takes.

**Cross-check** asks Pi-hole's own query log which of the listed failures Pi-hole
actually caused. Each host is then marked:

- `blocked` — Pi-hole's log confirms it refused this name. Allowing it will help.
- `not Pi-hole` — Pi-hole answered normally. The failure is something else, and
  allowing it will not help.
- `unseen` — Pi-hole never saw a query for it from this device.

Nothing is guessed on your behalf: before a cross-check, hosts are labelled
`not checked`.

**Turning back on lags; turning off does not.** A blocked answer lives 2 seconds in
the browser's cache, so switching Pi-hole off shows up on the next reload. The real
addresses the browser cached while Pi-hole was off live as long as their owners'
TTLs say — often a few minutes — so after switching back on, ads can linger until
those expire. Chrome's `chrome://net-internals/#dns` → Clear host cache ends it early.

### This device

The first time you use it, Breaker sets up two things on your Pi-hole:

- a group called **`Breaker: <your-hostname>`**, and
- a **client entry** for this machine — keyed on its MAC address when Pi-hole knows
  it, otherwise on its IP — belonging to `Default` **and** that group.

Tripping the device breaker moves the client into the Breaker group *alone*.
Gravity — the blocklists — is attached to `Default`, and the Breaker group has no
lists of its own, so a client in only that group resolves everything.

Resetting puts the previous membership back, exactly as it was. If you had this
machine in a "Kids" group, it goes back into "Kids".

Both the group and the client entry are tagged in Pi-hole's `comment` field, and
that tag carries the deadline. Which means the reset survives things it otherwise
would not: close the browser for the night, reinstall the extension, wipe your
Chrome profile — the next time any Breaker talks to that Pi-hole, it sees an expired
tag and restores filtering. Breaker will **only ever remove or rewrite an entry
whose comment proves Breaker created it**; a rule you wrote by hand is never touched.

### Whole network

`POST /api/dns/blocking {blocking: false, timer: 600}`. Pi-hole itself runs the
countdown and flips back when it lapses, so this reset does not depend on the
browser being open, the extension being installed, or the machine being on. The
popup shows Pi-hole's own remaining time rather than a second timer that could
disagree with it.

This is the switch to use when you are not sure the other two apply to you.

### The badge

| Badge | Meaning |
| --- | --- |
| **OFF** (red) | Network-wide blocking is off |
| **DEV** (amber) | This device is unfiltered |
| *number* (grey) | How many hosts look DNS-blocked on the current tab |
| *blank* | Nothing blocked on this tab |

---

## What Breaker cannot do

Stated plainly, because every one of these looks like a bug when it is not:

**Server-side inserted ads.** YouTube, Twitch, Spotify and most modern streaming
services stitch ads into the same stream, from the same hostnames, as the content.
There is no separate domain to block or allow, so DNS-based blocking never affected
them and Breaker cannot change that in either direction.

**Chrome's Secure DNS (DoH).** If Chrome resolves names over HTTPS to Cloudflare or
Google, your DNS never reaches Pi-hole and none of the three switches does anything
at all. Breaker detects this — if a tab has failures but Pi-hole's log shows no
queries from this device, the popup says so — and the fix is
`chrome://settings/security` → turn off **Use secure DNS**. A VPN with its own
resolver does the same thing.

**Anything that is not DNS.** In-page ad scripts served from a first-party domain,
cosmetic clutter, cookie banners, paywalls. Breaker is a switch for a DNS filter;
it is not a content blocker and does not read or modify page content.

### When the device is not what Pi-hole thinks

`GET /api/info/client` reports the source address of Breaker's own request. That is
this machine only if Pi-hole can see it directly. Behind a VPN, a NAT, or a second
router, the address Pi-hole sees is the gateway — and a "device" switch on a gateway
affects **everything behind it**, which is not what the button says.

Breaker never hides this. The options page shows exactly the address it resolved and
whether Pi-hole had a MAC for it, and the popup repeats the caveat when it is working
from an IP rather than a MAC. If the address shown is not this computer, use the
network switch, which does not depend on identity at all.

A MAC-keyed client entry is preferred over an IP-keyed one because DHCP leases move:
an IP-keyed entry would eventually start governing whichever device inherited the
lease.

---

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Your Pi-hole address and app password (`storage.local`), the Pi-hole session ID and the per-tab ledger (`storage.session`, which dies with the browser). |
| `alarms` | Scheduled resets. A service worker is stopped when idle, so a `setTimeout` would die with it and the reset would never happen; an alarm survives. |
| `webRequest` | Observing failed requests, which is the *only* way an extension can tell that a name was DNS-blocked. **Observation only** — Breaker uses `onErrorOccurred`, which cannot read, modify, or block anything. It does not request `webRequestBlocking`. |
| `webNavigation` | Clearing a tab's list when it navigates to a new page, so you never see the last page's blocked hosts. |
| `tabs` | Reading the current tab's URL — the site an allow is tagged with and the site the popup says it is acting on — and reloading the tab after you allow something. |
| `activeTab` | Acting on the tab whose popup you opened. |
| `<all_urls>` | Two reasons. `webRequest` must be told which URLs to observe, and a block can happen on any of them. And Pi-hole lives at an address only you know — `http://pi.hole`, some LAN IP — which cannot be declared in advance. |

**What Breaker does not do:** no analytics, no telemetry, no remote code, no
external network calls of any kind. It talks to exactly one host — your Pi-hole, at
the address you typed — and nowhere else. It never reads page content: no content
scripts are declared, and none are injected.

---

## Development

```bash
npm install
npm run build       # bundle into dist/
npm run watch       # rebuild src/ on change (restart after editing static/)
npm run typecheck   # tsc over src/ and over test/
npm test            # vitest
npm run package     # build, then zip dist/ into breaker-<version>.zip
npm run icons       # regenerate static/icons/*.png
```

### Layout

```
src/
  api/          Pi-hole and nothing else. No chrome.* here.
    client.ts   PiholeClient: fetch, session, one re-auth on 401, typed errors
    types.ts    wire types, transcribed from the Pi-hole v6 OpenAPI spec
    version.ts  version parsing and the v6 gate
  core/         Pure logic. No chrome.* here either — this is what the tests drive.
    scopes.ts   the three switches, plus the group arithmetic
    device.ts   "who am I": IP → MAC → client entry + group
    tags.ts     the ownership tag written into Pi-hole's comment field
    blocked-detect.ts  Chrome network error → block candidate; the per-tab ledger
  background.ts service worker: session, ledger, alarms, badge, message router
  messages.ts   the typed popup ↔ background contract
  popup.ts      three sections and a duration picker
  options.ts    connect, and what Breaker resolved about this device
static/         manifest, HTML, CSS, icons
scripts/        make-icons.mjs (pure-node PNG encoder), live-check.mjs
test/           vitest, against src/api and src/core
```

Two rules hold this shape together and are worth keeping:

1. **`src/api/` is the only module that knows Pi-hole exists.** Everything above it
   speaks Breaker's own vocabulary. That is what makes v7 — or a different DNS
   filter entirely — a change in one directory.
2. **`src/api/` and `src/core/` never import `chrome.*`.** They are ordinary
   TypeScript, so the tests run in Node with no browser shim and the live check can
   import the exact same modules the extension ships.

### The live check

The unit tests prove the logic against a stub. `scripts/live-check.mjs` proves the
wire format against a real Pi-hole:

```bash
PIHOLE_URL=http://pi.hole PIHOLE_PASSWORD=your-app-password npm run live-check
```

It bundles `src/api` and `src/core` with esbuild and imports them, so it exercises
the shipping code rather than a parallel implementation that could drift.

It exercises auth, the version gate, blocking get/set-with-timer/restore, group and
client creation and the unfiltered/restored membership swap, an allow entry added,
extended, swept and deleted with its tag round-tripped, and a query-log fetch.

**It leaves your Pi-hole exactly as it found it.** Every change registers an undo
before it happens and the undos run in reverse in a `finally`, so a failure halfway
through still restores your blocking mode and deletes the scratch entries. The
scratch names cannot collide with anything real: the client is `192.0.2.123`
(TEST-NET-1, RFC 5737) and the domain ends in `.invalid` (RFC 2606). Anything it
could not undo is reported loudly rather than left behind quietly.

---

## Contributing

Issues and pull requests are welcome.

Before opening a PR:

```bash
npm run typecheck && npm test && npm run build
```

House style, such as it is:

- **No `any` in `src/api` or `src/core`.** Strict TypeScript throughout.
- **Comments explain *why*.** The what is in the code. A comment earns its place by
  recording a measured fact, a trap, or a decision that looks wrong until you know
  the reason — see the note on `unfilteredGroups` returning `[breakerGroupId]` and
  never `[]`, which is exactly that kind of trap.
- **No silent fallbacks.** If something cannot be done, say which thing and why.
  Pi-hole's own error text reaches the user rather than being replaced with a
  friendlier lie.
- **Never touch a Pi-hole entry Breaker does not own.** The comment tag is the proof
  of ownership, and `parseTag` is deliberately strict: a comment Breaker cannot fully
  parse belongs to someone else.
- New behaviour in `src/core` comes with tests. `test/fake-pihole.ts` is an
  in-memory Pi-hole that holds real rows, so tests assert on resulting state rather
  than on call sequences.

---

## License

MIT © 2026 Owen Morgan. See [LICENSE](LICENSE).

Breaker is not affiliated with the Pi-hole project.
