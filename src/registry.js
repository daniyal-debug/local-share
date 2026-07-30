import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { config } from './config.js';
import { generatePlate, normalizePlate } from './plates.js';

const FILE_VERSION = 1;

/**
 * Every device keeps one permanent plate, the way a car keeps its number plate.
 * The plate is public — it is what other people type. The deviceId is private:
 * it is the browser's proof that it owns that plate, so it never leaves the
 * owning device except as a request header.
 */
class Registry extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, any>} deviceId -> device */
    this.devices = new Map();
    /** @type {Map<string, string>} plate -> deviceId */
    this.byPlate = new Map();
    this.file = path.join(config.dataDir, 'devices.json');
    this.saveTimer = null;
    this.load();
  }

  // ------------------------------------------------------------- persistence

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('could not read device file:', error.message);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('device file is not valid JSON; starting with an empty registry');
      return;
    }

    const cutoff = Date.now() - config.deviceTtlMs;
    for (const device of parsed?.devices || []) {
      if (!device?.deviceId || !normalizePlate(device.plate)) continue;
      if ((device.lastSeen || 0) < cutoff) continue;
      if (this.byPlate.has(device.plate)) continue;
      const restored = {
        deviceId: device.deviceId,
        plate: device.plate,
        name: device.name || 'A device',
        networkKey: device.networkKey || null,
        createdAt: device.createdAt || Date.now(),
        lastSeen: device.lastSeen || Date.now(),
        peers: new Map(Object.entries(device.peers || {})),
        blocked: new Set(device.blocked || [])
      };
      this.devices.set(restored.deviceId, restored);
      this.byPlate.set(restored.plate, restored.deviceId);
    }
    console.log(`Loaded ${this.devices.size} known device${this.devices.size === 1 ? '' : 's'}`);
  }

  save() {
    // Writes are debounced: a busy network would otherwise rewrite this per packet.
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 1000);
    this.saveTimer.unref?.();
  }

  saveNow() {
    const payload = {
      version: FILE_VERSION,
      devices: [...this.devices.values()].map((device) => ({
        deviceId: device.deviceId,
        plate: device.plate,
        name: device.name,
        networkKey: device.networkKey,
        createdAt: device.createdAt,
        lastSeen: device.lastSeen,
        peers: Object.fromEntries(device.peers),
        blocked: [...device.blocked]
      }))
    };
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(payload, null, 2));
      fs.renameSync(temp, this.file); // atomic, so a crash never truncates the file
    } catch (error) {
      console.error('could not persist devices:', error.message);
    }
  }

  // ----------------------------------------------------------------- devices

  /** Returns the caller's device, minting a plate the first time we see it. */
  claim(deviceId, { name, networkKey } = {}) {
    let device = this.devices.get(deviceId);
    if (!device) {
      device = {
        deviceId,
        plate: generatePlate((plate) => this.byPlate.has(plate)),
        name: name || 'A device',
        networkKey: networkKey || null,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        peers: new Map(),
        blocked: new Set()
      };
      this.devices.set(deviceId, device);
      this.byPlate.set(device.plate, deviceId);
      this.emit('change', device);
    }

    device.lastSeen = Date.now();
    if (name && name !== device.name) device.name = name;
    if (networkKey && networkKey !== device.networkKey) device.networkKey = networkKey;
    this.save();
    return device;
  }

  get(deviceId) {
    return this.devices.get(deviceId) || null;
  }

  /** Plates only resolve for devices last seen on the same network as the caller. */
  resolve(plate, networkKey) {
    const normalized = normalizePlate(plate);
    if (!normalized) return { error: 'malformed' };
    const deviceId = this.byPlate.get(normalized);
    const device = deviceId ? this.devices.get(deviceId) : null;
    if (!device) return { error: 'unknown' };
    if (networkKey && device.networkKey !== networkKey) return { error: 'other-network' };
    return { device };
  }

  rename(device, name) {
    device.name = String(name).trim().slice(0, 40) || device.name;
    this.save();
  }

  /** Issuing a fresh plate is the way out if someone abuses the old one. */
  rotatePlate(device) {
    this.byPlate.delete(device.plate);
    device.plate = generatePlate((plate) => this.byPlate.has(plate));
    this.byPlate.set(device.plate, device.deviceId);
    this.save();
    return device.plate;
  }

  // ------------------------------------------------------------------- peers

  savePeer(device, peer) {
    device.peers.set(peer.plate, { plate: peer.plate, name: peer.name, savedAt: Date.now() });
    device.blocked.delete(peer.plate);
    this.save();
  }

  forgetPeer(device, plate) {
    const removed = device.peers.delete(plate);
    this.save();
    return removed;
  }

  block(device, plate) {
    const normalized = normalizePlate(plate);
    if (!normalized) return false;
    device.blocked.add(normalized);
    device.peers.delete(normalized);
    this.save();
    return true;
  }

  unblock(device, plate) {
    const removed = device.blocked.delete(normalizePlate(plate) || plate);
    this.save();
    return removed;
  }

  isTrusted(device, plate) {
    return device.peers.has(plate);
  }

  isBlocked(device, plate) {
    return device.blocked.has(plate);
  }

  /** Everything the owner is allowed to see about itself. */
  publicSelf(device) {
    return {
      plate: device.plate,
      name: device.name,
      savedPeers: [...device.peers.values()].sort((a, b) => b.savedAt - a.savedAt),
      blocked: [...device.blocked]
    };
  }

  /** What other devices are allowed to see. Never the deviceId. */
  publicPeer(device) {
    return { plate: device.plate, name: device.name };
  }

  sweep() {
    const cutoff = Date.now() - config.deviceTtlMs;
    let dropped = 0;
    for (const [deviceId, device] of this.devices) {
      if (device.lastSeen >= cutoff) continue;
      this.devices.delete(deviceId);
      this.byPlate.delete(device.plate);
      dropped += 1;
    }
    if (dropped) this.save();
    return dropped;
  }
}

export const registry = new Registry();
