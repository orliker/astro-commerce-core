import { type Db, getSetting, logEvent, setSetting } from "@astro/db";
import type { RuntimeMode } from "@astro/shared-types";
import { canEnterLiveMode, LiveModeBlocked } from "./live-gate.ts";

export const MODES: RuntimeMode[] = ["DEVELOPMENT", "SIMULATION", "TEST", "LIVE"];

/**
 * Runtime mode is stored in settings (versioned, audited), with the env var as the initial value.
 * LIVE can never be reached silently: it requires an explicit owner approval record.
 */
export function getMode(db: Db): RuntimeMode {
  const env = (process.env.ASTRO_MODE || "DEVELOPMENT").toUpperCase() as RuntimeMode;
  const stored = getSetting<RuntimeMode | null>(db, "runtime.mode", null);
  const mode = stored ?? (MODES.includes(env) ? env : "DEVELOPMENT");
  if (mode === "LIVE" && !getSetting<boolean>(db, "runtime.live_approved", false)) {
    // Fail closed: LIVE without approval degrades to TEST and is logged loudly.
    logEvent(db, "error", "mode", "LIVE requested without owner approval; running as TEST");
    return "TEST";
  }
  return mode;
}

export function setMode(db: Db, mode: RuntimeMode, actor: string, reason: string): RuntimeMode {
  if (!MODES.includes(mode)) throw new Error(`Unknown mode ${mode}`);
  if (mode === "LIVE") {
    // Allowlist, not denylist: only an explicit owner actor with a written reason can switch to LIVE.
    if (!actor.startsWith("owner:") || reason.trim().length < 3) {
      throw new Error(
        "LIVE mode can only be set by the owner (actor owner:*) with a reason; never by an agent, a script or the system",
      );
    }
    // HARD GATE: owner approval is necessary, not sufficient. Critical blockers make LIVE impossible.
    const gate = canEnterLiveMode(db);
    if (!gate.ok) {
      logEvent(db, "error", "mode", "LIVE refused by hard gate", {
        actor,
        blockers: gate.blockers.map((b) => b.id),
      });
      throw new LiveModeBlocked(gate.blockers);
    }
    setSetting(db, "runtime.live_approved", true, actor, reason);
  }
  setSetting(db, "runtime.mode", mode, actor, reason);
  logEvent(db, "warn", "mode", `mode changed to ${mode}`, { actor, reason });
  return mode;
}

/** Irreversible external side effects are only allowed in TEST (sandbox) and LIVE. */
export function externalActionsAllowed(mode: RuntimeMode): boolean {
  return mode === "TEST" || mode === "LIVE";
}

export function isLive(mode: RuntimeMode): boolean {
  return mode === "LIVE";
}

// ---------- kill switches ----------

export interface KillSwitches {
  autonomyPaused: boolean;
  pausedStores: string[];
  pausedSuppliers: string[];
  socialPaused: boolean;
  pausedWorkers: string[];
}

export function getKillSwitches(db: Db): KillSwitches {
  return {
    autonomyPaused: getSetting(db, "kill.autonomy_paused", false),
    pausedStores: getSetting(db, "kill.paused_stores", [] as string[]),
    pausedSuppliers: getSetting(db, "kill.paused_suppliers", [] as string[]),
    socialPaused: getSetting(db, "kill.social_paused", false),
    pausedWorkers: getSetting(db, "kill.paused_workers", [] as string[]),
  };
}

export function pauseAutonomy(db: Db, paused: boolean, actor: string, reason = ""): void {
  setSetting(db, "kill.autonomy_paused", paused, actor, reason);
  logEvent(db, "warn", "kill-switch", paused ? "AUTONOMY PAUSED" : "autonomy resumed", { actor, reason });
}

export function pauseList(
  db: Db,
  key: "kill.paused_stores" | "kill.paused_suppliers" | "kill.paused_workers",
  id: string,
  paused: boolean,
  actor: string,
): string[] {
  const list = new Set(getSetting(db, key, [] as string[]));
  if (paused) list.add(id);
  else list.delete(id);
  const arr = [...list];
  setSetting(db, key, arr, actor);
  logEvent(db, "warn", "kill-switch", `${key} ${paused ? "pause" : "resume"} ${id}`, { actor });
  return arr;
}
