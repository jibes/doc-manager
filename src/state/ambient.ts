import { useEffect } from 'react';
import { create } from 'zustand';

import type { ThemeName } from '@/design/tokens';
import { shell } from '@/lib/shell';

/**
 * Auto appearance with a light sensor: Light in a lit room, Dark when it's dim. Readings come from the Android
 * app (the phone's light sensor) or, where a browser offers one, the Ambient Light Sensor API. Without a
 * sensor, Auto follows the system's light or dark mode instead.
 */

type Reading = (lux: number) => void;
type Source = { start(on: Reading): () => void };

type SensorCtor = new (o: { frequency: number }) => EventTarget & { illuminance: number | null; start(): void; stop(): void };
const BrowserSensor = typeof window !== 'undefined' ? (window as unknown as { AmbientLightSensor?: SensorCtor }).AmbientLightSensor : undefined;

const source: Source | null = shell?.hasLightSensor?.()
  ? {
      start(on) {
        const listen = (e: Event) => on(Number((e as CustomEvent<number>).detail));
        window.addEventListener('tessel-light', listen);
        shell!.light!(true);
        return () => {
          window.removeEventListener('tessel-light', listen);
          shell!.light!(false);
        };
      },
    }
  : BrowserSensor
    ? {
        start(on) {
          try {
            const sensor = new BrowserSensor({ frequency: 2 });
            const read = () => sensor.illuminance != null && on(sensor.illuminance);
            sensor.addEventListener('reading', read);
            sensor.start();
            return () => {
              sensor.removeEventListener('reading', read);
              sensor.stop();
            };
          } catch {
            return () => {};
          }
        },
      }
    : null;

/** Auto follows the light here (not only the system's mode). */
export const hasLightSensor = source != null;

/** Darkest first. */
const LEVELS: ThemeName[] = ['dark', 'light'];
/**
 * Lux where Auto turns Dark (below) or Light again (above): an evening room with a lamp stays Light. The gap
 * between them, and waiting for the light to hold for a few seconds, keep it from flickering when a shadow
 * passes or the phone tilts.
 */
const DOWN = [12];
const UP = [40];
const SETTLE_MS = 2500;

/** The level the light calls for, starting from the current one (hysteresis). */
export function levelFor(lux: number, current: number): number {
  let level = current;
  while (level > 0 && lux < DOWN[level - 1]) level--;
  while (level < LEVELS.length - 1 && lux > UP[level]) level++;
  return level;
}

export const useAmbient = create<{ theme: ThemeName | null }>(() => ({ theme: null }));

/** Follows the light while Auto is chosen (where there is a sensor); mounted once in the root layout. */
export function useAmbientLight(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !source) return;
    let current = -1;
    let pending: { level: number; since: number } | null = null;
    const stop = source.start((lux) => {
      if (!Number.isFinite(lux)) return;
      // The first reading applies at once; after that, a change has to hold for a moment.
      if (current < 0) {
        current = lux < DOWN[0] ? 0 : 1;
        useAmbient.setState({ theme: LEVELS[current] });
        return;
      }
      const next = levelFor(lux, current);
      if (next === current) {
        pending = null;
        return;
      }
      const now = Date.now();
      if (!pending || pending.level !== next) pending = { level: next, since: now };
      else if (now - pending.since >= SETTLE_MS) {
        current = next;
        pending = null;
        useAmbient.setState({ theme: LEVELS[current] });
      }
    });
    return () => {
      stop();
      useAmbient.setState({ theme: null });
    };
  }, [enabled]);
}
