import type { CameraState } from "../../../protocol/src/contracts";

export type LookInput = { sequence: number; yaw: number; pitch: number };

/** Presentation poses never change the authoritative physics or saved camera. */
export class CameraPresentation {
  private from?: CameraState;
  private to?: CameraState;
  private receivedAt = 0;
  private duration = 40;
  private epoch = -1;
  private sequence = 0;
  private look?: LookInput;

  receive(camera: CameraState, now: number, duration: number, epoch: number, acknowledgedLook: number): void {
    const previous = this.to ? this.sample(now) : camera;
    const reset = epoch !== this.epoch;
    if (reset || (this.look && acknowledgedLook >= this.look.sequence)) this.look = undefined;
    this.from = { ...(reset ? camera : previous) };
    this.to = { ...camera };
    this.receivedAt = now;
    this.duration = Math.max(1, duration);
    this.epoch = epoch;
  }

  sample(now: number): CameraState {
    const from = this.from!, to = this.to!;
    const t = Math.max(0, Math.min(1, (now - this.receivedAt) / this.duration));
    const angle = Math.atan2(Math.sin(to.yaw - from.yaw), Math.cos(to.yaw - from.yaw));
    return {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
      yaw: this.look?.yaw ?? from.yaw + angle * t,
      pitch: this.look?.pitch ?? from.pitch + (to.pitch - from.pitch) * t,
    };
  }

  turn(dx: number, dy: number, sensitivity: number, now: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const camera = this.sample(now);
    this.look = {
      sequence: ++this.sequence,
      yaw: camera.yaw - dx * sensitivity,
      pitch: Math.max(-Math.PI * 0.47, Math.min(Math.PI * 0.47, camera.pitch - dy * sensitivity)),
    };
  }

  get pendingLook(): LookInput | undefined {
    return this.look;
  }
}
