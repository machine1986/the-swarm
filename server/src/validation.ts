import { DANGER_LEVELS, STRATEGIES, type DangerLevel, type Strategy, type SwarmState } from "../../shared/types.ts";

export class ValidationError extends Error {}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function num(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError(`${path} must be a finite number`);
  if (value < min || value > max) throw new ValidationError(`${path} must be within ${min}..${max}`);
  return Math.round(value * 10) / 10;
}

function int(value: unknown, path: string, min: number, max: number): number {
  const n = num(value, path, min, max);
  if (!Number.isInteger(n)) throw new ValidationError(`${path} must be an integer`);
  return n;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ValidationError(`${path} must be a boolean`);
  return value;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], path: string): T {
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
    throw new ValidationError(`${path} must be one of ${options.join(", ")}`);
  }
  return value as T;
}

/** Validates an untrusted request body and rebuilds it with only the known fields. */
export function parseSwarmState(body: unknown): SwarmState {
  const root = obj(body, "body");
  const swarm = obj(root.swarm, "swarm");
  const env = obj(root.environment, "environment");

  return {
    swarm: {
      population: int(swarm.population, "swarm.population", 0, 100_000),
      energy: num(swarm.energy, "swarm.energy", 0, 100),
      cohesion: num(swarm.cohesion, "swarm.cohesion", 0, 100),
      dispersion: num(swarm.dispersion, "swarm.dispersion", 0, 100),
      currentStrategy: oneOf<Strategy>(swarm.currentStrategy, STRATEGIES, "swarm.currentStrategy"),
      radius: num(swarm.radius, "swarm.radius", 0, 100_000),
    },
    environment: {
      threatCount: int(env.threatCount, "environment.threatCount", 0, 1000),
      nearestThreatDistance:
        env.nearestThreatDistance === null
          ? null
          : num(env.nearestThreatDistance, "environment.nearestThreatDistance", 0, 100_000),
      surrounded: bool(env.surrounded, "environment.surrounded"),
      dangerLevel: oneOf<DangerLevel>(env.dangerLevel, DANGER_LEVELS, "environment.dangerLevel"),
      threatsNearby: int(env.threatsNearby, "environment.threatsNearby", 0, 1000),
      threatsApproaching: int(env.threatsApproaching, "environment.threatsApproaching", 0, 1000),
      occupiedSectors: int(env.occupiedSectors, "environment.occupiedSectors", 0, 8),
      nearestThreatIsolated: bool(env.nearestThreatIsolated, "environment.nearestThreatIsolated"),
      averageThreatStrength: num(env.averageThreatStrength, "environment.averageThreatStrength", 0, 100),
    },
  };
}
