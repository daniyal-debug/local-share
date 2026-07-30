import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import { config } from './config.js';

export function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

export const EVERYONE = 'EVERYONE';

/**
 * One record per thing sent. A transfer addressed to a plate lands in exactly
 * one inbox; a broadcast is addressed to a network instead and is visible to
 * every device on it.
 *
 * status:
 *   pending  - waiting for the recipient to accept a first contact
 *   accepted - the recipient can open it
 *   declined - kept briefly so the sender learns what happened, blob removed
 */
class Transfers extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, any>} */
    this.items = new Map();
    // Ordering key. Date.now() has millisecond granularity, so a burst of items
    // ties and any sort on it puts them in an arbitrary order.
    this.seq = 0;
    this.timer = setInterval(() => this.sweep(), config.sweepIntervalMs);
    this.timer.unref?.();
  }

  add(record) {
    const now = Date.now();
    const transfer = { id: newId(), seq: ++this.seq, createdAt: now, expiresAt: now + config.itemTtlMs, ...record };
    this.items.set(transfer.id, transfer);
    this.enforceInboxCap(transfer);
    return transfer;
  }

  get(id) {
    return this.items.get(id) || null;
  }

  /** Everything addressed to this device, newest first, plus network broadcasts. */
  inbox(deviceId, networkKey) {
    return [...this.items.values()]
      .filter((t) =>
        t.toDeviceId === deviceId ||
        (t.toDeviceId === null && t.networkKey === networkKey && t.fromDeviceId !== deviceId))
      .sort((a, b) => b.seq - a.seq);
  }

  sent(deviceId) {
    return [...this.items.values()]
      .filter((t) => t.fromDeviceId === deviceId)
      .sort((a, b) => b.seq - a.seq);
  }

  /** How many first-contact requests this sender already has waiting on a recipient. */
  pendingFrom(fromDeviceId, toDeviceId) {
    let count = 0;
    for (const transfer of this.items.values()) {
      if (transfer.status === 'pending' && transfer.fromDeviceId === fromDeviceId && transfer.toDeviceId === toDeviceId) {
        count += 1;
      }
    }
    return count;
  }

  /** Accepting one first contact accepts everything else already waiting from that sender. */
  acceptAllFrom(toDeviceId, fromDeviceId) {
    const accepted = [];
    for (const transfer of this.items.values()) {
      if (transfer.toDeviceId === toDeviceId && transfer.fromDeviceId === fromDeviceId && transfer.status === 'pending') {
        transfer.status = 'accepted';
        accepted.push(transfer);
      }
    }
    return accepted;
  }

  async declineAllFrom(toDeviceId, fromDeviceId) {
    const declined = [];
    for (const transfer of this.items.values()) {
      if (transfer.toDeviceId === toDeviceId && transfer.fromDeviceId === fromDeviceId && transfer.status === 'pending') {
        transfer.status = 'declined';
        await this.discardBlob(transfer); // a declined file should not sit on disk
        declined.push(transfer);
      }
    }
    return declined;
  }

  async remove(id) {
    const transfer = this.items.get(id);
    if (!transfer) return false;
    this.items.delete(id);
    await this.discardBlob(transfer);
    return true;
  }

  /** Clears one device's view: its inbox, or what it sent. */
  async clear(deviceId, networkKey, scope) {
    const doomed =
      scope === 'sent' ? this.sent(deviceId) : this.inbox(deviceId, networkKey).filter((t) => t.toDeviceId === deviceId);
    for (const transfer of doomed) {
      this.items.delete(transfer.id);
      await this.discardBlob(transfer);
    }
    return doomed.length;
  }

  /** Keeps one noisy sender from filling a recipient's inbox forever. */
  enforceInboxCap(transfer) {
    if (transfer.toDeviceId === null) return;
    const mine = [...this.items.values()]
      .filter((t) => t.toDeviceId === transfer.toDeviceId)
      .sort((a, b) => b.seq - a.seq);
    for (const old of mine.slice(config.maxItemsPerDevice)) {
      this.items.delete(old.id);
      void this.discardBlob(old);
    }
  }

  async sweep() {
    const now = Date.now();
    const expired = [];
    for (const [id, transfer] of this.items) {
      if (transfer.expiresAt > now) continue;
      this.items.delete(id);
      expired.push(transfer);
    }
    if (!expired.length) return;
    await Promise.all(expired.map((transfer) => this.discardBlob(transfer)));
    this.emit('expired', expired);
  }

  async discardBlob(transfer) {
    if (transfer?.kind !== 'file' || !transfer.storedPath) return;
    const target = transfer.storedPath;
    transfer.storedPath = null;
    try {
      await fs.unlink(target);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('could not remove blob', target, error.message);
    }
  }
}

/** Shape sent to browsers. Storage paths and deviceIds never leave the server. */
export function publicTransfer(transfer, viewerDeviceId) {
  const base = {
    id: transfer.id,
    kind: transfer.kind,
    status: transfer.status,
    from: { plate: transfer.fromPlate, name: transfer.fromName },
    to: transfer.toDeviceId === null ? { plate: EVERYONE, name: 'Everyone on this network' } : { plate: transfer.toPlate, name: transfer.toName },
    outgoing: transfer.fromDeviceId === viewerDeviceId,
    broadcast: transfer.toDeviceId === null,
    createdAt: transfer.createdAt,
    expiresAt: transfer.expiresAt
  };
  if (transfer.kind === 'text') return { ...base, text: transfer.status === 'declined' ? '' : transfer.text };
  return { ...base, name: transfer.name, size: transfer.size, mime: transfer.mime };
}

export const transfers = new Transfers();
