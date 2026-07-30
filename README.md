# LocalShare

Every device gets a permanent plate — `KRT-482` — the way a car has a number plate. Type someone
else's plate and send them text or files. They decide whether to accept. No signup, nothing in the
cloud, everything expires on a timer.

## Run it

```bash
npm install
npm start
```

```
LocalShare is running
  this device   http://localhost:3000
  same Wi-Fi    http://192.168.1.42:3000
  plates like   ABC-123
  items expire  30 min
```

Open the LAN address on a second device — or scan the QR from **QR code** — and each device shows
its own plate. Type one into the other and send.

## Why plates

Existing tools identify either a *transfer* or a *presence*, not a device:

| Tool | Identity | Trade-off |
| --- | --- | --- |
| [Send Anywhere](https://support.send-anywhere.com/hc/en-us/articles/115004269274-What-is-6-digit-Key-Transfer) | 6-digit key, one-time, 10 min | A fresh code for every transfer |
| [PairDrop](https://github.com/schlagmichdoch/PairDrop) | 6-digit pairing → shared secret | Persistent, but you must pair before the first send |
| [LocalSend](https://deepwiki.com/localsend/localsend/2.6-network-discovery) | Auto-discovery by alias | Nothing to type, but it breaks on AP isolation and odd subnets |

A plate is a permanent *address*: you can write it on a sticky note, read it down the hall, and it
still works next week. The cost is that a permanent public address is guessable, so the design
answers that directly — see [Abuse resistance](#abuse-resistance).

Plate letters come from a 22-letter alphabet that drops **I, L, O and U**, following
[Crockford's Base32](http://www.crockford.com/base32.html) reasoning: those are the characters
people misread when a code is spoken or copied by hand. Letters and digits sit in fixed sections,
so no position is ever ambiguous. Input is case- and separator-insensitive: `krt 482`, `KRT482`
and `krt-482` all resolve.

That gives 22³ × 10³ = 10,648,000 plates, and the registry never issues a duplicate.

## How sending works

1. **Resolve.** You type a plate. It only resolves if that device was last seen on *your* network.
2. **Send.** Text or files go to that one device. Nobody else on the network sees them.
3. **Consent.** A first contact from an unknown plate arrives as a **request**. The recipient can
   Accept, Accept and save, Decline, or Decline and block.
4. **Trust.** *Accept* releases everything currently waiting from that sender. *Accept and save*
   also trusts them, so their later sends arrive with no request step.

There is also a **Everyone** target that broadcasts to every device on your network — that needs no
consent, because it is addressed to the network you are already on rather than to you personally.

## Abuse resistance

A permanent address is guessable, so:

- **Network-scoped.** A plate only resolves for devices on the same network. Someone elsewhere
  cannot address you at all.
- **Indistinguishable failures.** "Unknown plate" and "real plate, different network" return the
  same 404, so a scanner cannot map which plates exist elsewhere.
- **Rate-limited lookups.** 20 per minute per device by default.
- **Queue cap.** An unaccepted sender may have at most 5 items waiting before being refused.
- **Consent by default.** Nothing from a stranger is openable until you accept it. Declining a
  request deletes the files from disk immediately.
- **Block and rotate.** Block a plate outright, or press **New plate** to issue yourself a fresh
  one; the old plate stops resolving instantly.

## Features

- Permanent per-device plates, persisted to disk so they survive restarts
- Targeted send by plate, plus broadcast to the whole network
- Live inbox, sent view, and presence over a WebSocket
- Nearby devices and saved contacts as one-tap chips, so you rarely type a plate
- Drag and drop, file picker, or paste straight from the clipboard
- Per-item countdown, manual delete, and clear-all
- Download the whole inbox as a zip
- Capability links (`/s/<id>?t=…`) for one item
- Light and dark themes, resolved before first paint
- Keyboard: `Ctrl` + `Enter` sends text, `Esc` closes dialogs

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `ITEM_TTL_MINUTES` | `30` | How long a transfer survives |
| `MAX_FILE_MB` | `512` | Per-file size cap |
| `MAX_FILES_PER_UPLOAD` | `20` | Files accepted in one request |
| `MAX_ITEMS_PER_DEVICE` | `80` | Inbox size; oldest entries fall off |
| `MAX_TEXT_CHARS` | `20000` | Per-snippet text cap |
| `LOOKUPS_PER_MINUTE` | `20` | Plate lookups per device per minute |
| `PENDING_PER_SENDER` | `5` | Items an unaccepted sender may queue |
| `DEVICE_TTL_DAYS` | `30` | A device keeps its plate this long after last being seen |
| `UPLOAD_DIR` | `./uploads` | Where blobs are written |
| `DATA_DIR` | `./data` | Where the device registry is persisted |
| `TRUST_PROXY` | off | Set to `1` **only** behind a proxy you control |

`TRUST_PROXY` makes the server believe `X-Forwarded-For`. Without a proxy in front, anyone could
set that header and appear to be on another network, so leave it off when the process is exposed
directly.

## What "the same network" means

| Situation | Grouping |
| --- | --- |
| Self-hosted on a LAN | Same `/24` subnet — `192.168.1.10` and `192.168.1.44` are together |
| Behind a reverse proxy | Same public address — one office NAT is one network |

Networks are shown by a hashed label (`Onyx Valley`), never as a raw address.

## Security notes

- **The `deviceId` is a bearer credential.** It lives in `localStorage`, is sent as a header, and
  proves ownership of a plate. Anyone who copies it can act as that device. It is a random UUID,
  which is appropriate for a LAN tool; it is not a substitute for real authentication.
- **Download links are capability URLs.** Each transfer gets an HMAC token that is only ever handed
  to the sender and the accepted recipient. The token is required because an `<a download>` cannot
  send an auth header. Anyone given the link can fetch that one item until it expires.
- **Plates are public by design.** They identify, they do not authenticate. Consent and blocking are
  what protect you, not the secrecy of the plate.
- **Files** are written to `UPLOAD_DIR` under a random opaque name; the original filename only lives
  in memory as metadata. They are deleted on expiry, deletion, decline, or clear.
- **Traffic is plain HTTP.** Fine on a home or office LAN; put it behind a reverse proxy with TLS if
  it is reachable from anywhere else.
- Transfers live in memory only, so a restart clears every inbox. Plates and saved contacts persist.

## API

All routes except the download links require an `x-device-id` header.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/me` | Your plate, network, nearby devices, inbox, sent, limits, QR |
| `POST` | `/api/lookup` | Resolve a plate on your network |
| `POST` | `/api/send` | Send text to a plate or to `EVERYONE` |
| `POST` | `/api/send-files` | Multipart send; fields `to` and `files` |
| `POST` | `/api/transfers/:id/accept` | Accept everything waiting from that sender (`{save}`) |
| `POST` | `/api/transfers/:id/decline` | Decline everything from that sender (`{block}`) |
| `GET` | `/api/transfers/:id/download?t=` | Download one item |
| `GET` | `/api/inbox/archive` | Accepted inbox files as a zip |
| `DELETE` | `/api/transfers/:id` | Remove one item |
| `POST` | `/api/clear` | Empty your inbox or your sent list (`{scope}`) |
| `POST` | `/api/name` | Rename this device |
| `POST` | `/api/plate/rotate` | Issue yourself a new plate |
| `POST` / `DELETE` | `/api/peers` | Save or forget a contact |
| `POST` / `DELETE` | `/api/blocked` | Block or unblock a plate |
| `GET` | `/s/:id?t=` | Capability link — text page, or redirect to the file |
| `WS` | `/ws?deviceId=` | Live state for one device |

## Layout

```
server.js          express app, routes, uploads, zip, WebSocket, capability tokens
src/config.js      environment-driven settings
src/plates.js      plate alphabet, generation, normalisation
src/registry.js    devices, plate index, saved peers, blocking, disk persistence
src/transfers.js   transfer records, consent status, expiry, blob cleanup
src/net.js         address normalisation, subnet grouping, network labels
public/            index.html, styles.css, app.js
```
