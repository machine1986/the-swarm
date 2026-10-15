import type { Strategy } from "../../../shared/types.ts";

/** Steering weights and limits. Blended continuously, so switching never snaps. */
export interface StrategyParams {
  maxSpeed: number;
  minSpeed: number;
  maxForce: number;
  separation: number;
  alignment: number;
  cohesion: number;
  formation: number;
  avoidance: number;
  avoidRadius: number;
  wander: number;
}

export const STRATEGY_PARAMS: Record<Strategy, StrategyParams> = {
  FLOCK: { maxSpeed: 155, minSpeed: 60, maxForce: 360, separation: 2.0, alignment: 1.15, cohesion: 0.55, formation: 0.32, avoidance: 2.4, avoidRadius: 150, wander: 0.8 },
  FLIGHT: { maxSpeed: 340, minSpeed: 150, maxForce: 900, separation: 1.5, alignment: 1.3, cohesion: 0.4, formation: 1.6, avoidance: 3.4, avoidRadius: 230, wander: 0.25 },
  ATTACK: { maxSpeed: 360, minSpeed: 120, maxForce: 1150, separation: 1.1, alignment: 0.4, cohesion: 0.15, formation: 2.7, avoidance: 0.4, avoidRadius: 60, wander: 0.35 },
  DEFEND: { maxSpeed: 270, minSpeed: 60, maxForce: 1150, separation: 0.9, alignment: 0.25, cohesion: 0.0, formation: 3.4, avoidance: 0.6, avoidRadius: 70, wander: 0.08 },
  SPLIT: { maxSpeed: 270, minSpeed: 80, maxForce: 950, separation: 1.5, alignment: 0.8, cohesion: 0.3, formation: 2.3, avoidance: 2.0, avoidRadius: 130, wander: 0.3 },
  REGROUP: { maxSpeed: 250, minSpeed: 30, maxForce: 1050, separation: 0.9, alignment: 0.5, cohesion: 0.6, formation: 2.9, avoidance: 1.6, avoidRadius: 120, wander: 0.08 },
};

/** Energy change per second (negative drains) before conservation is applied. */
export const ENERGY_RATE: Record<Strategy, number> = {
  FLOCK: 1.3,
  REGROUP: 0.9,
  DEFEND: -0.45,
  SPLIT: -0.9,
  FLIGHT: -1.7,
  ATTACK: -2.2,
};

export const STRATEGY_COLORS: Record<Strategy, number> = {
  FLOCK: 0x00e5ff,
  FLIGHT: 0x00ffd1,
  ATTACK: 0xff315a,
  DEFEND: 0x2f8bff,
  SPLIT: 0xb388ff,
  REGROUP: 0x9ff8ff,
};

export function copyParams(from: StrategyParams, to: StrategyParams): void {
  Object.assign(to, from);
}

export function blendParams(current: StrategyParams, target: StrategyParams, t: number): void {
  for (const key of Object.keys(current) as (keyof StrategyParams)[]) {
    current[key] += (target[key] - current[key]) * t;
  }
}
