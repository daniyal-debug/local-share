const $ = (id) => document.getElementById(id);

const el = {
  statusDot: $('statusDot'),
  networkLine: $('networkLine'),
  deviceName: $('deviceName'),
  deviceBtn: $('deviceBtn'),
  themeBtn: $('themeBtn'),
  footMeta: $('footMeta'),
  faqLimits: $('faqLimits'),

  myPlateText: $('myPlateText'),
  copyPlateBtn: $('copyPlateBtn'),
  qrBtn: $('qrBtn'),
  rotateBtn: $('rotateBtn'),

  plateInput: $('plateInput'),
  everyoneBtn: $('everyoneBtn'),
  sendHint: $('sendHint'),
  recipient: $('recipient'),
  recipientIcon: $('recipientIcon'),
  recipientName: $('recipientName'),
  recipientMeta: $('recipientMeta'),
  clearRecipientBtn: $('clearRecipientBtn'),

  compose: $('compose'),
  textInput: $('textInput'),
  textCount: $('textCount'),
  sendTextBtn: $('sendTextBtn'),
  dropzone: $('dropzone'),
  fileInput: $('fileInput'),
  fileHint: $('fileHint'),
  progress: $('progress'),
  progressFill: $('progressFill'),
  progressText: $('progressText'),

  requestList: $('requestList'),
  itemList: $('itemList'),
  emptyState: $('emptyState'),
  emptyTitle: $('emptyTitle'),
  emptyBody: $('emptyBody'),
  inboxBadge: $('inboxBadge'),
  downloadAllBtn: $('downloadAllBtn'),
  clearBtn: $('clearBtn'),

  nearbyList: $('nearbyList'),
  savedList: $('savedList'),
  blockedList: $('blockedList'),

  qrModal: $('qrModal'),
  qrHolder: $('qrHolder'),
  joinUrl: $('joinUrl'),
  copyUrlBtn: $('copyUrlBtn'),

  toasts: $('toasts')
};

const EVERYONE = 'EVERYONE';

// ---------------------------------------------------------------- identity

const ADJECTIVES = ['Quiet', 'Rapid', 'Copper', 'Violet', 'Silver', 'Bright', 'Calm', 'Bold', 'Warm', 'Clever'];
const NOUNS = ['Falcon', 'Otter', 'Comet', 'Cedar', 'Marble', 'Pilot', 'Lynx', 'Ember', 'Atlas', 'Robin'];

function readStore(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode — identity resets on reload, and so does the plate */
  }
}

function randomName() {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}

const device = {
  id: readStore('ls.deviceId', null) || crypto.randomUUID(),
  name: readStore('ls.deviceName', null) || randomName()
};
writeStore('ls.deviceId', device.id);
writeStore('ls.deviceName', device.name);

const state = {
  self: { plate: null, name: device.name, savedPeers: [], blocked: [] },
  network: { label: '' },
  nearby: [],
  inbox: [],
  sent: [],
  view: 'inbox',
  compose: 'text',
  recipient: null,
  clockOffset: 0,
  limits: {
    ttlMs: 30 * 60 * 1000,
    maxFileBytes: 512 * 1024 * 1024,
    maxFilesPerUpload: 20,
    maxItemsPerDevice: 80,
    maxTextChars: 20000
  }
};

// ---------------------------------------------------------------- helpers

function headers(extra = {}) {
  return { 'x-device-id': device.id, 'x-device-name': device.name, ...extra };
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: headers(options.headers) });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatCountdown(expiresAt) {
  const left = expiresAt - (Date.now() + state.clockOffset);
  if (left <= 0) return 'expiring';
  const minutes = Math.floor(left / 60000);
  if (minutes >= 1) return `${minutes} min left`;
  return `${Math.max(1, Math.ceil(left / 1000))} s left`;
}

function toast(message, kind = 'info') {
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.kind = kind;
  node.textContent = message;
  el.toasts.append(node);
  setTimeout(() => node.remove(), 4200);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function downloadUrl(item) {
  return `/api/transfers/${item.id}/download?t=${encodeURIComponent(item.token)}`;
}

function shareUrl(item) {
  return new URL(`/s/${item.id}?t=${encodeURIComponent(item.token)}`, location.origin).href;
}

function button(label, onClick, extraClass) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'ghost-btn' + (extraClass ? ` ${extraClass}` : '');
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

function miniPlate(plate) {
  const node = document.createElement('span');
  node.className = 'mini-plate';
  node.textContent = plate === EVERYONE ? 'EVERYONE' : plate;
  return node;
}

// ---------------------------------------------------------------- recipient

function plateShape(raw) {
  const compact = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  return compact.length <= 3 ? compact : `${compact.slice(0, 3)}-${compact.slice(3)}`;
}

const isCompletePlate = (value) => /^[A-Z]{3}-[0-9]{3}$/.test(value);

function setRecipient(target) {
  state.recipient = target;
  const has = Boolean(target);

  el.recipient.hidden = !has;
  el.compose.setAttribute('aria-disabled', String(!has));
  el.sendHint.textContent = has ? 'Ready to send' : 'Type a plate';

  if (has) {
    const everyone = target.plate === EVERYONE;
    el.recipientIcon.textContent = everyone ? 'ALL' : target.plate.slice(0, 3);
    el.recipientName.textContent = everyone ? 'Everyone on this network' : target.name;
    el.recipientMeta.textContent = everyone
      ? `${state.nearby.length} device${state.nearby.length === 1 ? '' : 's'} online right now`
      : [target.plate, target.online ? 'online' : 'offline — will see it when it reconnects', target.saved ? 'saved' : null]
          .filter(Boolean)
          .join(' · ');
  }
  syncTextControls();
}

let lookupTimer = null;
let lookupSeq = 0;

function scheduleLookup() {
  clearTimeout(lookupTimer);
  const value = el.plateInput.value;
  if (!isCompletePlate(value)) {
    el.plateInput.classList.remove('is-bad');
    if (state.recipient?.plate !== EVERYONE) setRecipient(null);
    return;
  }
  el.sendHint.textContent = 'Looking up…';
  lookupTimer = setTimeout(() => runLookup(value), 300);
}

async function runLookup(plate) {
  const seq = ++lookupSeq;
  try {
    const result = await api('/api/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plate })
    });
    if (seq !== lookupSeq) return; // a newer lookup already won
    el.plateInput.classList.remove('is-bad');
    setRecipient(result.target);
  } catch (error) {
    if (seq !== lookupSeq) return;
    el.plateInput.classList.add('is-bad');
    setRecipient(null);
    el.sendHint.textContent = error.message;
  }
}

function chooseplate(plate) {
  el.plateInput.value = plateShape(plate);
  scheduleLookup();
  el.plateInput.focus();
}

// ---------------------------------------------------------------- render

const ICONS = {
  text: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 6.5h14M5 12h14M5 17.5h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none"><path d="M13 3.5H8A2.5 2.5 0 0 0 5.5 6v12A2.5 2.5 0 0 0 8 20.5h8a2.5 2.5 0 0 0 2.5-2.5V9m-5.5-5.5L18.5 9m-5.5-5.5V9h5.5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
};

function itemNode(item) {
  const node = document.createElement('div');
  node.className = 'item' + (item.outgoing ? ' is-mine' : '');

  const icon = document.createElement('div');
  icon.className = 'item-icon';
  icon.innerHTML = ICONS[item.kind];

  const body = document.createElement('div');
  body.className = 'item-body';

  if (item.kind === 'text') {
    const pre = document.createElement('pre');
    pre.className = 'item-text';
    pre.textContent = item.text;
    body.append(pre);
  } else {
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = item.name;
    body.append(title);
  }

  const meta = document.createElement('div');
  meta.className = 'item-meta';
  meta.append(miniPlate(item.outgoing ? item.to.plate : item.from.plate));

  const words = [
    item.outgoing
      ? `To ${item.broadcast ? 'everyone here' : item.to.name}`
      : `From ${item.from.name}${item.broadcast ? ' (broadcast)' : ''}`,
    item.kind === 'file' ? formatBytes(item.size) : `${item.text.length} characters`
  ];
  if (item.status === 'pending') words.push('waiting to be accepted');
  if (item.status === 'declined') words.push('declined');

  for (const word of words) {
    const span = document.createElement('span');
    span.textContent = word;
    meta.append(span);
  }
  const countdown = document.createElement('span');
  countdown.className = 'countdown';
  countdown.dataset.expires = String(item.expiresAt);
  countdown.textContent = formatCountdown(item.expiresAt);
  meta.append(countdown);
  body.append(meta);

  const actions = document.createElement('div');
  actions.className = 'item-actions';

  if (item.token) {
    if (item.kind === 'text') {
      actions.append(button('Copy', () => {
        copyToClipboard(item.text).then((ok) => toast(ok ? 'Copied to clipboard' : 'Could not copy', ok ? 'ok' : 'error'));
      }));
    } else {
      const link = document.createElement('a');
      link.className = 'ghost-btn';
      link.href = downloadUrl(item);
      link.textContent = 'Download';
      link.setAttribute('download', item.name);
      actions.append(link);
    }
    actions.append(button('Link', () => {
      const url = shareUrl(item);
      copyToClipboard(url).then((ok) => toast(ok ? 'Link copied' : url, ok ? 'ok' : 'info'));
    }));
  }

  actions.append(button('Delete', () => removeItem(item.id), 'danger'));

  node.append(icon, body, actions);
  return node;
}

/** Pending items are grouped by sender: one decision covers everything waiting. */
function requestNode(group) {
  const node = document.createElement('div');
  node.className = 'request';

  const head = document.createElement('div');
  head.className = 'request-head';
  head.append(miniPlate(group.plate));

  const title = document.createElement('div');
  title.className = 'request-title';
  title.textContent = `${group.name} wants to send you ${group.items.length} item${group.items.length === 1 ? '' : 's'}`;
  head.append(title);

  const preview = document.createElement('div');
  preview.className = 'request-preview';
  for (const item of group.items.slice(0, 5)) {
    const line = document.createElement('div');
    line.textContent = item.kind === 'file' ? `${item.name} · ${formatBytes(item.size)}` : `Text · ${item.text.length} characters`;
    preview.append(line);
  }
  if (group.items.length > 5) {
    const more = document.createElement('div');
    more.textContent = `and ${group.items.length - 5} more`;
    preview.append(more);
  }

  const actions = document.createElement('div');
  actions.className = 'request-actions';

  const accept = document.createElement('button');
  accept.type = 'button';
  accept.className = 'primary-btn';
  accept.textContent = 'Accept';
  accept.addEventListener('click', () => respond(group.items[0].id, 'accept', { save: false }));

  actions.append(
    accept,
    button('Accept and save', () => respond(group.items[0].id, 'accept', { save: true })),
    button('Decline', () => respond(group.items[0].id, 'decline', { block: false })),
    button('Decline and block', () => respond(group.items[0].id, 'decline', { block: true }), 'danger')
  );

  node.append(head, preview, actions);
  return node;
}

function groupPending(items) {
  const groups = new Map();
  for (const item of items) {
    if (item.status !== 'pending' || item.outgoing) continue;
    const key = item.from.plate;
    if (!groups.has(key)) groups.set(key, { plate: key, name: item.from.name, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

function chip(peer, { removable, onRemove, offline, title } = {}) {
  const node = document.createElement('div');
  node.className = 'chip' + (offline ? ' chip-off' : '');

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'chip-open';
  open.title = title || `Send to ${peer.plate}`;
  open.append(miniPlate(peer.plate));

  const name = document.createElement('span');
  name.className = 'chip-name';
  name.textContent = peer.name || 'Unknown device';
  open.append(name);
  open.addEventListener('click', () => chooseplate(peer.plate));
  node.append(open);

  if (removable) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'chip-x';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.addEventListener('click', onRemove);
    node.append(remove);
  }
  return node;
}

function renderChips(container, entries, emptyText, options = {}) {
  container.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('span');
    empty.className = 'chip-empty';
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }
  for (const entry of entries) container.append(chip(entry, options(entry)));
}

function render() {
  const inboxPending = groupPending(state.inbox);
  const showingInbox = state.view === 'inbox';

  el.requestList.replaceChildren(...(showingInbox ? inboxPending.map(requestNode) : []));

  const items = showingInbox
    ? state.inbox.filter((item) => item.status !== 'pending')
    : state.sent;
  el.itemList.replaceChildren(...items.map(itemNode));

  const pendingCount = inboxPending.reduce((total, group) => total + group.items.length, 0);
  el.inboxBadge.hidden = pendingCount === 0;
  el.inboxBadge.textContent = String(pendingCount);

  const nothing = items.length === 0 && (!showingInbox || inboxPending.length === 0);
  el.emptyState.hidden = !nothing;
  el.emptyTitle.textContent = showingInbox ? 'Nothing in your inbox' : 'You have not sent anything';
  el.emptyBody.textContent = showingInbox
    ? 'Give someone your plate and whatever they send lands here.'
    : 'Type a plate above, then send text or drop in a file.';

  const downloadable = showingInbox && state.inbox.some((item) => item.kind === 'file' && item.status === 'accepted');
  el.downloadAllBtn.disabled = !downloadable;
  el.clearBtn.disabled = items.length === 0 && inboxPending.length === 0;

  el.myPlateText.textContent = state.self.plate || '···-···';
  el.deviceName.textContent = state.self.name || device.name;
  el.networkLine.textContent = state.network.label
    ? `${state.network.label} · ${state.nearby.length} nearby`
    : 'Connecting';

  renderChips(el.nearbyList, state.nearby, 'No other devices online here right now.', () => ({}));
  renderChips(el.savedList, state.self.savedPeers, 'Accept and save a sender to keep them here.', (peer) => ({
    removable: true,
    offline: peer.known === false || peer.online === false,
    title: peer.known === false ? 'Not on this network any more — it may have taken a new plate' : undefined,
    onRemove: () => forgetPeer(peer.plate)
  }));
  renderChips(
    el.blockedList,
    state.self.blocked.map((plate) => ({ plate, name: 'Blocked' })),
    'Nobody is blocked.',
    (peer) => ({ removable: true, onRemove: () => unblock(peer.plate) })
  );
}

function tickCountdowns() {
  for (const node of el.itemList.querySelectorAll('.countdown')) {
    node.textContent = formatCountdown(Number(node.dataset.expires));
  }
}
setInterval(tickCountdowns, 1000);

function applyState(message) {
  state.self = message.self || state.self;
  state.network = message.network || state.network;
  state.nearby = message.nearby || [];
  state.inbox = message.inbox || [];
  state.sent = message.sent || [];
  if (message.now) state.clockOffset = message.now - Date.now();
  if (state.self.name) device.name = state.self.name;
  render();
}

// ---------------------------------------------------------------- actions

async function respond(id, action, body) {
  try {
    const result = await api(`/api/transfers/${id}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (action === 'accept') {
      toast(`Accepted ${result.accepted} item${result.accepted === 1 ? '' : 's'}${result.saved ? ' and saved the sender' : ''}`, 'ok');
    } else {
      toast(`Declined ${result.declined} item${result.declined === 1 ? '' : 's'}${result.blocked ? ' and blocked the plate' : ''}`, 'ok');
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function removeItem(id) {
  try {
    await api(`/api/transfers/${id}`, { method: 'DELETE' });
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function forgetPeer(plate) {
  try {
    await api(`/api/peers/${encodeURIComponent(plate)}`, { method: 'DELETE' });
    toast(`Removed ${plate}`, 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function unblock(plate) {
  try {
    await api(`/api/blocked/${encodeURIComponent(plate)}`, { method: 'DELETE' });
    toast(`Unblocked ${plate}`, 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function syncTextControls() {
  const length = el.textInput.value.trim().length;
  el.textCount.textContent = `${length.toLocaleString()} character${length === 1 ? '' : 's'}`;
  el.sendTextBtn.disabled = !state.recipient || length === 0 || length > state.limits.maxTextChars;
}

async function sendText() {
  const text = el.textInput.value.trim();
  if (!text || !state.recipient) return;
  el.sendTextBtn.disabled = true;
  try {
    const result = await api('/api/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: state.recipient.plate, text })
    });
    el.textInput.value = '';
    toast(
      result.transfer.status === 'pending'
        ? `Sent — waiting for ${state.recipient.name} to accept`
        : `Sent to ${state.recipient.plate === EVERYONE ? 'everyone here' : state.recipient.plate}`,
      'ok'
    );
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    syncTextControls();
  }
}

function sendFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  if (!state.recipient) {
    toast('Choose who to send to first.', 'error');
    return;
  }
  if (files.length > state.limits.maxFilesPerUpload) {
    toast(`Up to ${state.limits.maxFilesPerUpload} files at a time.`, 'error');
    return;
  }
  const tooBig = files.find((file) => file.size > state.limits.maxFileBytes);
  if (tooBig) {
    toast(`"${tooBig.name}" is larger than ${formatBytes(state.limits.maxFileBytes)}.`, 'error');
    return;
  }

  const form = new FormData();
  form.append('to', state.recipient.plate);
  for (const file of files) form.append('files', file, file.name);

  const request = new XMLHttpRequest();
  request.open('POST', '/api/send-files');
  for (const [key, value] of Object.entries(headers())) request.setRequestHeader(key, value);

  el.progress.hidden = false;
  el.progressFill.style.width = '0%';
  el.progressText.textContent = `Sending ${files.length} file${files.length === 1 ? '' : 's'}…`;

  request.upload.addEventListener('progress', (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.round((event.loaded / event.total) * 100);
    el.progressFill.style.width = `${percent}%`;
    el.progressText.textContent = `Sending — ${percent}%`;
  });

  request.addEventListener('load', () => {
    el.progress.hidden = true;
    if (request.status >= 200 && request.status < 300) {
      toast(`${files.length} file${files.length === 1 ? '' : 's'} sent`, 'ok');
    } else {
      let message = `Send failed (${request.status})`;
      try {
        message = JSON.parse(request.responseText).error || message;
      } catch {
        /* keep the status message */
      }
      toast(message, 'error');
    }
  });

  request.addEventListener('error', () => {
    el.progress.hidden = true;
    toast('Send failed — the connection dropped.', 'error');
  });

  request.send(form);
}

// ---------------------------------------------------------------- socket

let socket = null;
let retryDelay = 800;

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({ deviceId: device.id, deviceName: device.name });
  socket = new WebSocket(`${protocol}://${location.host}/ws?${params}`);

  socket.addEventListener('open', () => {
    retryDelay = 800;
    el.statusDot.dataset.state = 'online';
  });

  socket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'state') applyState(message);
    } catch {
      /* ignore malformed frames */
    }
  });

  socket.addEventListener('close', () => {
    el.statusDot.dataset.state = 'offline';
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 1.7, 15000);
  });

  socket.addEventListener('error', () => socket.close());
}

async function loadSession() {
  try {
    const session = await api('/api/me');
    state.limits = session.limits;
    applyState(session);

    const minutes = Math.round(session.limits.ttlMs / 60000);
    el.fileHint.textContent = `or click to browse — up to ${formatBytes(session.limits.maxFileBytes)} each`;
    el.faqLimits.textContent =
      `Files up to ${formatBytes(session.limits.maxFileBytes)} each, ${session.limits.maxFilesPerUpload} at a time, ` +
      `${session.limits.maxItemsPerDevice} items per device, text up to ${session.limits.maxTextChars.toLocaleString()} characters. ` +
      `Items expire after ${minutes} minutes. All of it is configurable through environment variables.`;
    el.footMeta.textContent = `Items expire after ${minutes} minutes · your address on this network is ${session.yourIp}`;
    el.plateInput.placeholder = session.plateShape;

    el.joinUrl.textContent = session.joinUrl;
    el.qrHolder.innerHTML = session.qr || '';
  } catch (error) {
    toast(error.message, 'error');
  }
}

// ---------------------------------------------------------------- wiring

el.plateInput.addEventListener('input', () => {
  const cursorAtEnd = el.plateInput.selectionStart === el.plateInput.value.length;
  el.plateInput.value = plateShape(el.plateInput.value);
  if (cursorAtEnd) el.plateInput.setSelectionRange(el.plateInput.value.length, el.plateInput.value.length);
  scheduleLookup();
});

el.everyoneBtn.addEventListener('click', () => {
  el.plateInput.value = '';
  el.plateInput.classList.remove('is-bad');
  setRecipient({ plate: EVERYONE, name: 'Everyone on this network' });
});

el.clearRecipientBtn.addEventListener('click', () => {
  el.plateInput.value = '';
  el.plateInput.classList.remove('is-bad');
  setRecipient(null);
});

el.textInput.addEventListener('input', syncTextControls);
el.textInput.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    sendText();
  }
});
el.sendTextBtn.addEventListener('click', sendText);

for (const tab of document.querySelectorAll('[data-compose]')) {
  tab.addEventListener('click', () => {
    state.compose = tab.dataset.compose;
    for (const other of document.querySelectorAll('[data-compose]')) {
      other.classList.toggle('is-active', other === tab);
    }
    for (const pane of document.querySelectorAll('[data-pane]')) {
      pane.hidden = pane.dataset.pane !== state.compose;
    }
  });
}

for (const tab of document.querySelectorAll('[data-view]')) {
  tab.addEventListener('click', () => {
    state.view = tab.dataset.view;
    for (const other of document.querySelectorAll('[data-view]')) {
      other.classList.toggle('is-active', other === tab);
    }
    render();
  });
}

el.dropzone.addEventListener('click', () => el.fileInput.click());
el.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    el.fileInput.click();
  }
});
el.fileInput.addEventListener('change', () => {
  sendFiles(el.fileInput.files);
  el.fileInput.value = '';
});

let dragDepth = 0;
document.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  dragDepth += 1;
  el.dropzone.classList.add('is-over');
});
document.addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) el.dropzone.classList.remove('is-over');
});
document.addEventListener('drop', (event) => {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  dragDepth = 0;
  el.dropzone.classList.remove('is-over');
  sendFiles(event.dataTransfer.files);
});

document.addEventListener('paste', (event) => {
  if (event.target === el.textInput || event.target === el.plateInput) return;
  const files = [...(event.clipboardData?.files || [])];
  if (files.length) {
    event.preventDefault();
    sendFiles(files);
  }
});

// The archive route is authenticated by header, which a plain <a> cannot send,
// so fetch it and hand the browser a blob URL instead.
el.downloadAllBtn.addEventListener('click', async () => {
  try {
    const response = await fetch('/api/inbox/archive', { headers: headers() });
    if (!response.ok) {
      throw new Error((await response.json().catch(() => ({}))).error || 'Nothing to download.');
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = 'localshare-inbox.zip';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (error) {
    toast(error.message, 'error');
  }
});

el.clearBtn.addEventListener('click', async () => {
  const scope = state.view;
  const what = scope === 'sent' ? 'everything you have sent' : 'your whole inbox';
  if (!confirm(`Remove ${what}?`)) return;
  try {
    const result = await api('/api/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope })
    });
    toast(`Cleared ${result.removed} item${result.removed === 1 ? '' : 's'}`, 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
});

el.copyPlateBtn.addEventListener('click', async () => {
  if (!state.self.plate) return;
  const ok = await copyToClipboard(state.self.plate);
  toast(ok ? `Copied ${state.self.plate}` : state.self.plate, ok ? 'ok' : 'info');
});

el.rotateBtn.addEventListener('click', async () => {
  if (!confirm('Issue a new plate? Anyone holding the old one will no longer reach this device.')) return;
  try {
    const result = await api('/api/plate/rotate', { method: 'POST' });
    toast(`Your plate is now ${result.plate}`, 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
});

el.deviceBtn.addEventListener('click', async () => {
  const next = prompt('Name this device', state.self.name || device.name);
  if (next === null) return;
  const name = next.trim().slice(0, 40);
  if (!name) return;
  try {
    const result = await api('/api/name', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name })
    });
    device.name = result.name;
    writeStore('ls.deviceName', result.name);
  } catch (error) {
    toast(error.message, 'error');
  }
});

el.qrModal.addEventListener('click', (event) => {
  if (event.target === el.qrModal || event.target.closest('[data-close]')) el.qrModal.hidden = true;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') el.qrModal.hidden = true;
});
el.qrBtn.addEventListener('click', () => {
  el.qrModal.hidden = false;
});
el.copyUrlBtn.addEventListener('click', async () => {
  const ok = await copyToClipboard(el.joinUrl.textContent);
  el.copyUrlBtn.textContent = ok ? 'Copied' : 'Copy';
  setTimeout(() => (el.copyUrlBtn.textContent = 'Copy'), 1600);
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0b0d12' : '#f5f6fa');
  writeStore('ls.theme', theme);
}

el.themeBtn.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

// ---------------------------------------------------------------- start

document.querySelector('meta[name="theme-color"]')
  ?.setAttribute('content', document.documentElement.dataset.theme === 'dark' ? '#0b0d12' : '#f5f6fa');

el.deviceName.textContent = device.name;
setRecipient(null);
render();
loadSession();
connect();
