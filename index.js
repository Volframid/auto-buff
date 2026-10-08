'use strict';

const fs = require('fs');
const path = require('path');
const Automation = require('./lib/automation');

module.exports = function AutoBuff(mod) {
  mod.game.initialize(['me', 'inventory', 'contract']);
  const configPath = path.join(__dirname, 'config.json');
  const profilesPath = path.join(__dirname, 'class-buffs.json');
  const statePath = path.join(__dirname, 'cooldowns.json');
  let config = readConfig(), profiles = readProfiles(), profileClass = null, profile = null;
  let location = null, facing = 0, character = null, learning = null, logFile = null;
  const acceptedTriggers = new Set();
  let ownCastAt = -Infinity;
  const stored = readJson(statePath, {});
  const options = { order: -9000002, filter: { fake: false, modified: null, silenced: null } };
  const engine = new Automation({
    config, now: Date.now,
    setTimeout: (fn, delay) => mod.setTimeout(fn, delay), clearTimeout: timer => mod.clearTimeout(timer),
    available: () => mod.game.isIngame && !mod.game.isInLoadingScreen && mod.game.me.alive &&
      !!profile && profileClass === mod.game.me.class && !mod.game.me.mounted && !mod.game.contract.active && location !== null,
    select: selectItems,
    send: sendItem,
    record
  });
  applyProfile();

  function readProfiles() {
    const data = readJson(profilesPath, null);
    const ids = list => Array.isArray(list) && list.length > 0 && list.every(id => Number.isInteger(id) && id > 0);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid class-buffs.json.');
    for (const [job, entry] of Object.entries(data)) {
      if (!Array.isArray(entry.skills) || !entry.skills.length ||
          entry.requiresOwnCast !== undefined && typeof entry.requiresOwnCast !== 'boolean' ||
          !entry.skills.every(skill => typeof skill.name === 'string' && skill.name.length && ids(skill.skillIds) && ids(skill.buffIds)))
        throw new Error(`Invalid class buff profile: ${job}.`);
    }
    return data;
  }
  function applyProfile() {
    const job = mod.game.me.class;
    if (profileClass !== job) {
      engine.reset(); acceptedTriggers.clear(); ownCastAt = -Infinity;
    }
    profileClass = job; profile = profiles[job] || null;
    const triggerBuffIds = [...new Set([
      ...(profile?.skills.flatMap(skill => skill.buffIds) || []),
      ...(job === 'lancer' ? config.adrenalineBuffIds : [])
    ])];
    engine.config = { ...config, triggerBuffIds, playerClass: job,
      triggerNames: profile?.skills.map(skill => skill.name) || [] };
    for (const id of acceptedTriggers) if (!triggerBuffIds.includes(id)) {
      acceptedTriggers.delete(id); engine.buffs.delete(id);
    }
    engine.wake();
  }
  function observeOwnCast(packet) {
    if (profileClass !== mod.game.me.class) applyProfile();
    const id = Number(typeof packet.skill === 'object' ? packet.skill?.id : packet.skill);
    if (profile?.requiresOwnCast && profile.skills.some(skill => skill.skillIds.includes(id))) {
      ownCastAt = Date.now();
      record('CLASS_BUFF_CAST', { class: profileClass, skillId: id });
    }
  }

  function message(text) { mod.command.message(`[Auto Buff] ${text}`); }
  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw new Error(`Cannot read ${file}: ${error.message}`);
    }
  }
  function readConfig() {
    const data = readJson(configPath, null);
    const ids = list => Array.isArray(list) && list.every(id => Number.isInteger(id) && id > 0);
    if (!data || typeof data.enabled !== 'boolean' || !ids(data.adrenalineBuffIds) ||
        !data.adrenalineBuffIds.length || !ids(data.beer?.itemIds) || !ids(data.beer?.buffIds) ||
        !ids(data.brooch?.buffIds) || typeof data.beer.enabled !== 'boolean' ||
        typeof data.brooch.enabled !== 'boolean' ||
        !(data.brooch.itemId === null || Number.isInteger(data.brooch.itemId) && data.brooch.itemId > 0))
      throw new Error('Invalid Auto Buff config: IDs must be positive integers.');
    for (const kind of ['brooch', 'beer']) {
      data[kind].cooldownBuffIds ??= [];
      if (!ids(data[kind].cooldownBuffIds)) throw new Error(`Invalid ${kind} cooldownBuffIds.`);
    }
    for (const [key, min, max] of [['acknowledgementMs', 100, 5000], ['retryDelayMs', 100, 5000],
      ['maxAttempts', 1, 5], ['itemSpacingMs', 50, 1000]]) {
      if (!Number.isInteger(data[key]) || data[key] < min || data[key] > max)
        throw new Error(`Invalid ${key}: expected ${min}..${max}.`);
    }
    return data;
  }
  function save(file, data) {
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(temporary, file);
  }
  function record(stage, data = {}) {
    if (!logFile) return;
    try { fs.appendFileSync(logFile, JSON.stringify({ utc: new Date().toISOString(), stage,
      character, ...data }, (_, value) => typeof value === 'bigint' ? value.toString() : value) + '\n'); }
    catch (error) { logFile = null; mod.error(`Auto Buff log stopped: ${error.message}`); }
  }
  function selectItems(kind) {
    if (kind === 'brooch') {
      // The installed S_ITEMLIST definition identifies equipment slot 20 as brooch.
      const equipped = mod.game.inventory.equipmentItems.find(item => item.slot === 20);
      return equipped && (!config.brooch.itemId || config.brooch.itemId === equipped.id) ? [equipped] : [];
    }
    return config.beer.itemIds.map(id => mod.game.inventory.findInBagOrPockets(id))
      .filter(item => item && item.amount > 0);
  }
  function sendItem(item) {
    const packet = {
      gameId: mod.game.me.gameId, id: item.id, dbid: item.dbid || 0n, target: 0n, amount: 1,
      dest: { x: 0, y: 0, z: 0 }, loc: location, w: facing,
      unk1: 0, unk2: 0, unk3: 0, unk4: true
    };
    record('AUTO_ITEM_PACKET', packet);
    mod.toServer('C_USE_ITEM', 3, packet);
  }
  function saveCooldowns() {
    if (!character) return;
    stored[character] = {
      items: Object.fromEntries([...engine.cooldowns].filter(([, until]) => until > Date.now())),
      buffs: Object.fromEntries([...engine.cooldownBuffs].filter(([, until]) => until > Date.now()))
    };
    try { save(statePath, stored); }
    catch (error) { mod.error(`Cannot save item cooldowns: ${error.message}`); }
  }
  function ownBuff(name, packet) {
    if (packet.target !== mod.game.me.gameId) return;
    if (profileClass !== mod.game.me.class) applyProfile();
    record(name, { id: packet.id, duration: packet.duration, stacks: packet.stacks,
      source: packet.source, class: profileClass,
      name: mod.game.data?.abnormalities?.get(packet.id)?.name });
    const trigger = engine.triggerIds().includes(packet.id);
    if (!trigger && !['brooch', 'beer'].some(kind =>
        config[kind].buffIds.includes(packet.id) || config[kind].cooldownBuffIds.includes(packet.id))) return;
    if (name === 'S_ABNORMALITY_END') {
      acceptedTriggers.delete(packet.id); engine.endBuff(packet.id);
    }
    else {
      // Shared healer buffs must follow our own cast, not a party member's buff.
      if (trigger && profile?.requiresOwnCast && !acceptedTriggers.has(packet.id)) {
        const recentCast = Date.now() - ownCastAt <= 15000;
        const ownSource = packet.source === mod.game.me.gameId;
        if (!recentCast && !ownSource) {
          record('CLASS_BUFF_IGNORED', { id: packet.id, reason: 'no-own-cast' }); return;
        }
        if (profileClass === 'priest' && packet.source != null && packet.source !== 0n && !ownSource) {
          record('CLASS_BUFF_IGNORED', { id: packet.id, reason: 'other-caster' }); return;
        }
      }
      const duration = Number(packet.duration);
      const data = mod.game.data?.abnormalities?.get(packet.id);
      const infinite = trigger && profileClass === 'brawler' &&
        (data?.infinity === true || data?.infinity === 1 || data?.infinity === 'true');
      if (infinite || Number.isSafeInteger(duration) && duration > 0) {
        if (trigger) acceptedTriggers.add(packet.id);
        engine.buff(packet.id, infinite ? Infinity : duration);
      }
    }
    if (['brooch', 'beer'].some(kind => config[kind].cooldownBuffIds.includes(packet.id))) saveCooldowns();
  }
  mod.hook('S_ABNORMALITY_BEGIN', mod.majorPatchVersion <= 106 ? 4 : 5, options,
    packet => ownBuff('S_ABNORMALITY_BEGIN', packet));
  mod.hook('S_ABNORMALITY_REFRESH', 2, options, packet => ownBuff('S_ABNORMALITY_REFRESH', packet));
  mod.hook('S_ABNORMALITY_END', 1, options, packet => ownBuff('S_ABNORMALITY_END', packet));
  mod.hook('S_START_COOLTIME_ITEM', 1, options, packet => {
    const milliseconds = Number(packet.cooldown) * 1000;
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    engine.cooldown(packet.item, Date.now() + milliseconds);
    if (config.beer.itemIds.includes(packet.item) || selectItems('brooch').some(item => item.id === packet.item))
      saveCooldowns();
  });
  mod.hook('C_USE_ITEM', 3, { order: -9000002, filter: { fake: false, modified: null, silenced: false } }, packet => {
    record('MANUAL_ITEM_REQUEST', { ...packet,
      name: mod.game.data?.items?.get(packet.id)?.name });
    if (learning && learning.until > Date.now()) {
      const kind = learning.kind;
      if (kind === 'brooch' && !selectItems('brooch').some(item => item.id === packet.id)) {
        message('Learning: use the equipped brooch. Other items are ignored.');
      } else {
        if (kind === 'brooch') config.brooch.itemId = packet.id;
        else config.beer.itemIds = [packet.id];
        try { save(configPath, config); message(`${kind} learned: item ${packet.id}.`); }
        catch (error) { message(`Could not save: ${error.message}`); }
        learning = null;
      }
    }
    engine.manual(packet.id);
  });
  mod.hook('S_SYSTEM_MESSAGE', 1, options, packet => {
    if (!engine.active() || !logFile) return;
    record('SYSTEM_MESSAGE', { message: packet.message });
  });
  mod.hook('S_LOGIN', mod.majorPatchVersion >= 86 ? 14 : 13, packet => {
    engine.reset(true); location = null; learning = null;
    acceptedTriggers.clear(); ownCastAt = -Infinity; applyProfile();
    character = `${packet.serverId ?? mod.serverId}:${packet.playerId ?? mod.game.me.playerId}`;
    const saved = stored[character] || {};
    for (const [id, until] of Object.entries(saved.items || saved))
      if (Number.isInteger(Number(id)) && Number.isFinite(until) && until > Date.now())
        engine.cooldowns.set(Number(id), until);
    for (const [id, until] of Object.entries(saved.buffs || {}))
      if (Number.isInteger(Number(id)) && Number.isFinite(until) && until > Date.now())
        engine.cooldownBuffs.set(Number(id), until);
  });
  mod.hook('S_SPAWN_ME', 3, packet => { location = packet.loc; facing = packet.w; applyProfile(); });
  mod.hook('C_START_SKILL', 7, { order: -9000002, filter: { fake: false, modified: null, silenced: false } }, observeOwnCast);
  mod.hook('C_PLAYER_LOCATION', 5, { filter: { fake: false } }, packet => {
    const wasUnknown = location === null;
    location = packet.loc; facing = packet.w;
    if (wasUnknown) engine.wake();
  });
  mod.hook('S_ACTION_STAGE', 9, options, packet => {
    if (packet.gameId === mod.game.me.gameId) {
      const wasUnknown = location === null;
      location = packet.loc; facing = packet.w; observeOwnCast(packet);
      if (wasUnknown) engine.wake();
    }
  });
  function pause() { engine.reset(); acceptedTriggers.clear(); ownCastAt = -Infinity; location = null; learning = null; }
  function leave() { saveCooldowns(); engine.reset(true); acceptedTriggers.clear(); ownCastAt = -Infinity;
    location = null; character = null; learning = null; }
  const onInventory = () => engine.wake();
  const onReady = () => applyProfile();
  mod.game.on('leave_game', leave);
  mod.game.on('enter_loading_screen', pause);
  mod.game.on('leave_loading_screen', onReady);
  mod.game.me.on('die', pause);
  mod.game.me.on('dismount', onReady);
  mod.game.me.on('change_template', onReady);
  mod.game.contract.on('end', onReady);
  mod.game.inventory.on('update', onInventory);

  function setEnabled(kind, enabled) {
    const next = kind ? { ...config, [kind]: { ...config[kind], enabled } } : { ...config, enabled };
    // Apply only after saving succeeds so an I/O error cannot change the active settings.
    save(configPath, next);
    config = next;
    applyProfile();
    message(`${kind || 'Auto Buff'} ${enabled ? 'ON' : 'OFF'}`);
  }

  mod.command.add('buff', (action = 'status', argument) => {
    action = action.toLowerCase();
    if (action === 'on' || action === 'off') {
      try { setEnabled(null, action === 'on'); }
      catch (error) { message(error.message); }
    } else if (action === 'beer' || action === 'brooch') {
      const option = argument?.toLowerCase();
      if (option === 'status') {
        const remaining = Math.max(0, engine.cooldownUntil(action, selectItems(action)) - Date.now());
        message(`${action} ${config[action].enabled ? 'ON' : 'OFF'} | known cooldown ${Math.ceil(remaining / 1000)}s`);
      } else if (option === undefined || option === 'on' || option === 'off') {
        try { setEnabled(action, option === undefined ? !config[action].enabled : option === 'on'); }
        catch (error) { message(error.message); }
      } else message(`buff ${action} [on/off/status]`);
    } else if (action === 'reload') {
      try {
        const nextConfig = readConfig(), nextProfiles = readProfiles();
        config = nextConfig; profiles = nextProfiles; applyProfile();
        message('config.json and class-buffs.json reloaded.');
      }
      catch (error) { message(error.message); }
    } else if (action === 'learn' && ['brooch', 'beer'].includes(argument?.toLowerCase())) {
      learning = { kind: argument.toLowerCase(), until: Date.now() + 30000 };
      message(`Use ${learning.kind} manually once within 30 seconds. Its item ID will be saved.`);
    } else if (action === 'log') {
      if (logFile) { record('SESSION_END'); logFile = null; message('Log OFF.'); }
      else {
        const folder = path.join(__dirname, 'logs');
        try {
          fs.mkdirSync(folder, { recursive: true });
          logFile = path.join(folder, `auto-buff-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
          record('SESSION_START', { config, class: profileClass, profile }); message('Log ON.');
        } catch (error) { logFile = null; message(error.message); }
      }
    } else if (action === 'status') {
      message(`${config.enabled ? 'ON' : 'OFF'} | ${profileClass || 'unknown class'} | ` +
        `${engine.config.triggerNames.join(' / ') || 'no class profile'}: ${engine.active() ? 'active' : 'inactive'}`);
      for (const kind of ['brooch', 'beer']) {
        const items = selectItems(kind);
        const state = config[kind].enabled ? 'ON' : 'OFF';
        if (!items.length) { message(`${kind} ${state}: not found${kind === 'brooch' ? ' in equipped slot 20' : ' in inventory'}.`); continue; }
        const remaining = Math.max(0, engine.cooldownUntil(kind, items) - Date.now());
        message(`${kind} ${state}: ${items.map(item => item.id).join(', ')} | known cooldown ${Math.ceil(remaining / 1000)}s`);
      }
    } else message('buff on/off/status/reload/log | buff beer/brooch [on/off/status] | buff learn beer/brooch');
  });
  this.destructor = () => {
    saveCooldowns(); engine.reset(true);
    mod.game.removeListener('leave_game', leave);
    mod.game.removeListener('enter_loading_screen', pause);
    mod.game.removeListener('leave_loading_screen', onReady);
    mod.game.me.removeListener('die', pause);
    mod.game.me.removeListener('dismount', onReady);
    mod.game.me.removeListener('change_template', onReady);
    mod.game.contract.removeListener('end', onReady);
    mod.game.inventory.removeListener('update', onInventory);
    mod.command.remove('buff');
    record('MODULE_UNLOAD'); logFile = null;
  };
};
