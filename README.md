# Auto Buff

Standalone brooch and Lein's Dark Root Beer automation for all 13 TERA classes. No other mod or external skill list is required.

## How it works

The module detects your class and waits for its actual server-confirmed buff. It uses the equipped brooch and available beer individually, 100 ms apart. An item still on cooldown is used when its real cooldown ends, provided the class buff is still active. It never casts or cancels a skill, or creates a fake buff.

| Class | Trigger |
|---|---|
| Warrior | Deadly Gamble |
| Lancer | Adrenaline Rush |
| Slayer | In Cold Blood |
| Berserker | Fiery Rage / Unleash; Fiery Rage does not require Unleash |
| Sorcerer | Mana Boost |
| Archer | Windsong |
| Priest | Edict of Judgment |
| Mystic | Thrall of Wrath |
| Reaper | Shadow Reaping |
| Gunner | Modular Weapon System |
| Brawler | Growing Fury |
| Ninja | Inner Harmony |
| Valkyrie | Ragnarok |

`class-buffs.json` includes the listed skills' ranks and variants from the skill list, plus the actual buff IDs from game data. Skill IDs and buff IDs are separate. Cooldown resets, passive effects and similarly named boss buffs are excluded. Only the player's own class profile applies.

Priest and Mystic buffs can also be received from other players. Their initial activation must follow a matching player skill request/confirmed action within 15 seconds, or identify the player as its source. Priest ignores a known different caster. The 15 seconds validates the cast association; the active automation window always comes from the real buff duration.

Growing Fury with native infinity metadata stays active until its buff removal; it does not create a polling loop. Items are confirmed once per continuous buff window. Concurrent buff components and refreshes do not repeatedly consume confirmed items.

Berserker can use beer during each separate Fiery Rage window without waiting for Unleash. Beer and brooch follow their own server-reported cooldowns; the module does not assume a fixed 55-second or 3-minute recharge.

Server restrictions still apply. In particular, Unleash's game description restricts item use. A rejected item request is not treated as success, and the mod does not bypass that restriction. Missing confirmations use bounded retries, up to four attempts per item readiness period.

## Installation and commands

Place the `auto-buff` folder in Toolbox's `mods` directory and restart Toolbox. Keep only one copy. The shared default is ON; existing saved settings are preserved.

| Command | Action |
|---|---|
| `buff` / `buff status` | Show selected class, trigger buffs, equipped items and known cooldowns |
| `buff on` / `buff off` | Save enabled state |
| `buff beer on` / `buff beer off` | Save beer automation preference |
| `buff brooch on` / `buff brooch off` | Save brooch automation preference |
| `buff beer` / `buff brooch` | Toggle that item and save |
| `buff beer status` / `buff brooch status` | Show that item's preference and known cooldown |
| `buff reload` | Reload all of `config.json` and `class-buffs.json` |
| `buff learn beer` | Use the intended beer manually within 30 seconds to save its item ID |
| `buff learn brooch` | Use the equipped brooch manually to save its ID; normally equipment detection is enough |
| `buff log` | Start/stop a diagnostic recording in `logs/` |

Code changes require restarting Toolbox. Logging starts OFF.

Beer and brooch can be disabled independently without turning off the other item. Their preferences survive restarting the game and Toolbox. `buff off` pauses the whole module; item switches do not override it. Known cooldowns continue to be tracked while an item is disabled.

## Settings and cooldowns

Edit `config.json` for item IDs, enabled state and retry pacing. Edit each class's named entries in `class-buffs.json` for server-specific skill/buff IDs, then run `buff reload`. The legacy `adrenalineBuffIds` setting remains a Lancer-only extension; it never applies to other classes.

The brooch is detected from equipment slot 20. Its recharge follows both the item cooldown and Shadow Rest (`301807`), using whichever expires later. A short item lock never replaces the longer recharge. Cooldowns persist per server/character in `cooldowns.json` and remain separate from active buff tracking.

Automation pauses during loading, death, mounting or restricted contracts, and stops when the buff ends. Class changes clear the previous class's active buff tracking while retaining known item cooldowns. Packet identifiers are never stored as BigInt settings.

## Sharing and updates

Share source files and default configuration; exclude `cooldowns.json`, `logs/` and Toolbox's `module.config.json`. The included `.gitignore` covers them.

Automatic updates are enabled and downloaded from this repository's `main` branch when Toolbox starts its update check. Existing `config.json` and `class-buffs.json` files are preserved, including item preferences. Personal cooldowns and logs are never distributed.

Install the `auto-buff` folder from the latest release ZIP into Toolbox's `mods` directory. Keep only one copy and restart Toolbox. For source downloads, remove GitHub's branch suffix from the folder name so it is `auto-buff`.

The repository regenerates SHA-256 file hashes automatically after changes to `main`. Maintainers can also run `node scripts/build-manifest.cjs` locally. Toolbox's global and per-module update switches must remain enabled to receive updates.
