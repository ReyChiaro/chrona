import { t } from "../../../packages/i18n/src/index";
import type {
  WorldReadModel as WorldRuntime,
  MovementInput,
} from "../../../packages/world/src/ports/read-model";

export class RoamInput {
  private keys = new Set<string>();
  private abort = new AbortController();
  private suspended = false;
  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly runtime: WorldRuntime,
    onLock: (locked: boolean) => void,
    private readonly onError: (message: string) => void = () => undefined,
  ) {
    const { signal } = this.abort;
    canvas.addEventListener("click", () => void this.enter(), { signal });
    document.addEventListener(
      "pointerlockchange",
      () => {
        const locked = document.pointerLockElement === canvas;
        if (!locked) this.keys.clear();
        onLock(locked);
      },
      { signal },
    );
    window.addEventListener(
      "keydown",
      (event) => {
        if (this.suspended || document.pointerLockElement !== canvas) return;
        if (event.code === "Escape") {
          document.exitPointerLock();
          return;
        }
        if (
          [
            "KeyW",
            "KeyA",
            "KeyS",
            "KeyD",
            "ShiftLeft",
            "ShiftRight",
            "Space",
          ].includes(event.code)
        ) {
          event.preventDefault();
          this.keys.add(event.code);
        }
      },
      { signal },
    );
    window.addEventListener("keyup", (event) => this.keys.delete(event.code), {
      signal,
    });
    document.addEventListener(
      "mousemove",
      (event) => {
        if (!this.suspended && document.pointerLockElement === canvas)
          runtime.look(event.movementX, event.movementY);
      },
      { signal },
    );
    window.addEventListener("blur", () => this.keys.clear(), { signal });
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) this.keys.clear();
      },
      { signal },
    );
  }
  async enter(): Promise<void> {
    if (this.suspended || this.abort.signal.aborted) return;
    try {
      this.canvas.focus();
      await this.canvas.requestPointerLock();
    } catch {
      this.onError(
        t("ui.input.the-browser-could-not-lock-the-pointer-open-the"),
      );
    }
  }
  snapshot(): MovementInput {
    if (
      this.suspended ||
      (document.activeElement as HTMLElement)?.closest(
        'input,textarea,[contenteditable="true"]',
      )
    )
      return { forward: 0, right: 0, sprint: false, jump: false };
    return {
      forward: Number(this.keys.has("KeyW")) - Number(this.keys.has("KeyS")),
      right: Number(this.keys.has("KeyD")) - Number(this.keys.has("KeyA")),
      sprint: this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"),
      jump: this.keys.has("Space"),
    };
  }
  dispose(): void {
    this.abort.abort();
    this.keys.clear();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }
  resume(): void {
    this.suspended = false;
  }
  async suspend(): Promise<void> {
    this.suspended = true;
    this.keys.clear();
    if (document.pointerLockElement !== this.canvas) return;
    // Focusing an editor before the browser finishes unlocking can silently fail.
    await new Promise<void>((resolve) => {
      const finish = () => {
        document.removeEventListener("pointerlockchange", unlocked);
        this.abort.signal.removeEventListener("abort", finish);
        resolve();
      };
      const unlocked = () => {
        if (document.pointerLockElement !== this.canvas) finish();
      };
      document.addEventListener("pointerlockchange", unlocked);
      this.abort.signal.addEventListener("abort", finish, { once: true });
      document.exitPointerLock();
      unlocked();
    });
  }
}
