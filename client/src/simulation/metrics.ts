import type { DangerLevel, SwarmState } from "../../../shared/types.ts";
import { TAU } from "./math.ts";
import type { World } from "./World.ts";

const NEARBY = 350;
const ISOLATION = 260;

/** Condenses the world into the compact state Jev evaluates. No per-particle data. */
export function buildSwarmState(world: World): SwarmState {
  const cx = world.centerX;
  const cy = world.centerY;
  const threats = world.threats;

  let nearest: (typeof threats)[number] | undefined;
  let nearestDist = Infinity;
  let nearby = 0;
  let approaching = 0;
  let strengthSum = 0;
  let danger = 0;
  const sectors = new Set<number>();

  for (const th of threats) {
    const dx = cx - th.x;
    const dy = cy - th.y;
    const centreDist = Math.hypot(dx, dy);
    const edge = Math.max(0, centreDist - th.radius);
    if (edge < nearestDist) {
      nearestDist = edge;
      nearest = th;
    }
    if (edge < NEARBY) nearby++;
    if (th.vx * dx + th.vy * dy > 0 && Math.hypot(th.vx, th.vy) > 5) approaching++;
    strengthSum += th.strength;
    sectors.add(Math.floor(((Math.atan2(th.y - cy, th.x - cx) + Math.PI) / TAU) * 8) % 8);
    // Each threat contributes by strength, scaled down with distance (full at ≤100, none at ≥750).
    const proximity = Math.max(0, Math.min(1, 1 - (edge - 100) / 650));
    danger += (th.strength / 60) * proximity;
  }

  const isolated =
    nearest !== undefined &&
    threats.every((th) => th === nearest || Math.hypot(th.x - nearest!.x, th.y - nearest!.y) > ISOLATION);
  const surrounded = sectors.size >= 5 && nearby >= 3;

  return {
    swarm: {
      population: world.aliveCount,
      energy: round1(world.energy),
      cohesion: round1(world.cohesion),
      dispersion: round1(world.dispersion),
      currentStrategy: world.strategy,
      radius: Math.round(world.rms * 1.4),
    },
    environment: {
      threatCount: threats.length,
      nearestThreatDistance: nearest ? Math.round(nearestDist) : null,
      surrounded,
      dangerLevel: dangerLevel(threats.length, danger, surrounded),
      threatsNearby: nearby,
      threatsApproaching: approaching,
      occupiedSectors: sectors.size,
      nearestThreatIsolated: isolated,
      averageThreatStrength: threats.length ? round1(strengthSum / threats.length) : 0,
    },
  };
}

export function dangerLevel(threatCount: number, danger: number, surrounded: boolean): DangerLevel {
  if (threatCount === 0) return "none";
  if (danger >= 3.5 || (surrounded && danger >= 2)) return "critical";
  if (danger >= 1.8) return "high";
  if (danger >= 0.8) return "medium";
  return "low";
}

const round1 = (v: number): number => Math.round(v * 10) / 10;
