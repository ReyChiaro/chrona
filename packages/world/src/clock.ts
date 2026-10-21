import type { WorldConfig } from '../../protocol/src/config';

export class WorldClock {
  tick = 0;
  elapsedSeconds = 0;
  paused = false;
  constructor(public config: WorldConfig['clock']) {}
  advance(dt: number): void {
    this.advanceFixed(dt * this.config.timeScale);
  }
  advanceFixed(dt: number): void {
    if (this.paused) return;
    this.tick++;
    this.elapsedSeconds += dt;
  }
  get hour(): number { return ((this.config.initialHour + this.elapsedSeconds / this.config.dayDuration * 24) % 24 + 24) % 24; }
  get label(): string {
    const h = Math.floor(this.hour), m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
