'use strict';

// Server deadlines drive this scheduler. No polling, skill packets or fake buffs.
module.exports = class AutoBuffAutomation {
  constructor({ config, now, setTimeout, clearTimeout, available, select, send, record }) {
    Object.assign(this, { config, now, setTimeout, clearTimeout, available, select, send, record });
    this.buffs = new Map();
    this.cooldowns = new Map();
    this.cooldownBuffs = new Map();
    this.attempts = new Map();
    this.done = new Set();
    this.timer = null;
    this.nextSendAt = 0;
  }
  activeUntil() {
    return Math.max(0, ...this.triggerIds().map(id => this.buffs.get(id) || 0));
  }
  triggerIds() { return this.config.triggerBuffIds ?? this.config.adrenalineBuffIds ?? []; }
  active() { return this.activeUntil() > this.now(); }
  cooldownUntil(kind, candidates) {
    const ids = kind === 'beer' ? this.config.beer.itemIds : candidates.map(item => item.id);
    return Math.max(0, ...ids.map(id => this.cooldowns.get(id) || 0),
      ...(this.config[kind].cooldownBuffIds || []).map(id => this.cooldownBuffs.get(id) || 0));
  }
  buff(id, duration) {
    const wasActive = this.active();
    this.buffs.set(id, this.now() + duration);
    if (this.triggerIds().includes(id) && !wasActive) {
      this.attempts.clear(); this.done.clear(); this.nextSendAt = 0;
      this.record('CLASS_BUFF_ACTIVE', { id, durationMs: Number.isFinite(duration) ? duration : null,
        infinite: duration === Infinity, class: this.config.playerClass, names: this.config.triggerNames });
    }
    for (const kind of ['brooch', 'beer']) {
      if ((this.config[kind].cooldownBuffIds || []).includes(id))
        this.cooldownBuffs.set(id, this.now() + duration);
      if (this.config[kind].buffIds.includes(id) && this.active()) {
        this.done.add(kind);
        this.record('ITEM_BUFF_CONFIRMED', { kind, id });
      }
    }
    this.wake();
  }
  endBuff(id) { this.buffs.delete(id); this.cooldownBuffs.delete(id); this.wake(); }
  cooldown(id, until) {
    this.cooldowns.set(id, until);
    // A reported remaining cooldown can be a rejected use, not a success.
    // Wait for this deadline rather than marking the item consumed.
    if (until > this.now()) this.attempts.delete(id);
    this.record('ITEM_COOLDOWN', { id, remainingMs: Math.max(0, until - this.now()) });
    this.wake();
  }
  manual(id) {
    if (!this.active()) return;
    const attempt = this.attempts.get(id) || { count: 0, nextAt: 0 };
    attempt.count++;
    attempt.nextAt = this.now() + this.config.acknowledgementMs + this.config.retryDelayMs;
    this.attempts.set(id, attempt);
    this.wake();
  }
  wake() {
    if (this.timer !== null) this.clearTimeout(this.timer);
    this.timer = null;
    if (!this.config.enabled || !this.active()) return;
    const now = this.now(), expires = this.activeUntil();
    let next = expires;
    if (this.available()) {
      for (const kind of ['brooch', 'beer']) {
        if (!this.config[kind].enabled || this.done.has(kind)) continue;
        const buffUntil = Math.max(0, ...this.config[kind].buffIds.map(id => this.buffs.get(id) || 0));
        if (buffUntil > now) { next = Math.min(next, buffUntil); continue; }
        const candidates = this.select(kind);
        // Server item cooldown is normally shared among variants of the same item.
        const familyUntil = this.cooldownUntil(kind, candidates);
        for (const item of candidates.slice(0, 1)) {
          const attempt = this.attempts.get(item.id);
          if (attempt?.count >= this.config.maxAttempts && familyUntil <= now) continue;
          const readyAt = Math.max(familyUntil > now ? familyUntil + 10 : now,
            attempt?.nextAt || 0, this.nextSendAt);
          if (readyAt < expires) next = Math.min(next, readyAt);
        }
      }
    }
    // Infinite buffs have no expiry timer; only actual item deadlines schedule work.
    if (Number.isFinite(next))
      this.timer = this.setTimeout(() => { this.timer = null; this.tick(); }, Math.max(1, next - now));
  }
  tick() {
    if (!this.config.enabled || !this.active() || !this.available()) { this.wake(); return; }
    const now = this.now();
    for (const kind of ['brooch', 'beer']) {
      if (!this.config[kind].enabled || this.done.has(kind)) continue;
      if (this.config[kind].buffIds.some(id => (this.buffs.get(id) || 0) > now)) continue;
      const candidates = this.select(kind);
      if (this.cooldownUntil(kind, candidates) > now) continue;
      const item = candidates[0];
      if (!item) continue;
      const attempt = this.attempts.get(item.id) || { count: 0, nextAt: 0 };
      if (attempt.count >= this.config.maxAttempts || attempt.nextAt > now || this.nextSendAt > now) continue;
      attempt.count++;
      attempt.nextAt = now + this.config.acknowledgementMs + this.config.retryDelayMs * attempt.count;
      this.attempts.set(item.id, attempt);
      this.nextSendAt = now + this.config.itemSpacingMs;
      this.record('AUTO_ITEM_REQUEST', { kind, id: item.id, attempt: attempt.count });
      try { this.send(item); }
      catch (error) { this.record('AUTO_ITEM_SEND_ERROR', { kind, id: item.id, message: error.message }); }
      break; // Send items individually; never a duplicate-use burst.
    }
    this.wake();
  }
  reset(clearCooldowns = false) {
    if (this.timer !== null) this.clearTimeout(this.timer);
    this.timer = null; this.buffs.clear(); this.attempts.clear(); this.done.clear(); this.nextSendAt = 0;
    if (clearCooldowns) { this.cooldowns.clear(); this.cooldownBuffs.clear(); }
  }
};
