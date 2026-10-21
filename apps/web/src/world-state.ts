import {
  setTranslatedAttribute,
  setText,
} from "../../../packages/i18n/src/browser";
import { t } from "../../../packages/i18n/src/index";
import type { WorldRuntime } from "../../../packages/adapters/src/runtime/client";
import { icon } from "./layout";

const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

export class WorldStatePanel {
  constructor(
    private getWorld: () => WorldRuntime,
    save: () => Promise<void>,
    toast: (message: string, error?: boolean) => void,
  ) {
    element("world-state-toggle").addEventListener("click", () => {
      const world = getWorld();
      element<HTMLInputElement>("state-speed").value = String(
        world.config.clock.timeScale,
      );
      element<HTMLInputElement>("state-hour").value =
        world.clock.hour.toFixed(1);
      element<HTMLDialogElement>("world-state-dialog").showModal();
      this.update();
    });
    element("world-state-close").addEventListener("click", () =>
      element<HTMLDialogElement>("world-state-dialog").close(),
    );
    element("state-pause").addEventListener("click", () => {
      getWorld().clock.paused = !getWorld().clock.paused;
      this.update();
    });
    element("state-drop").addEventListener("click", async () => {
      try {
        await getWorld().dropPhysicsObject();
        element<HTMLDialogElement>("world-state-dialog").close();
        toast(
          getWorld().clock.paused || getWorld().config.clock.timeScale === 0
            ? t(
                "ui.world-state.physics-cube-queued-it-will-be-dropped-when-the",
              )
            : t(
                "ui.world-state.physics-cube-dropped-its-position-and-motion-will-be",
              ),
        );
      } catch (error) {
        toast((error as Error).message, true);
      }
    });
    element("state-save").addEventListener(
      "click",
      () =>
        void save()
          .then(() =>
            toast(t("ui.world-state.world-time-and-physics-state-saved")),
          )
          .catch((error) => toast(error.message, true)),
    );
    element<HTMLInputElement>("state-speed").addEventListener(
      "change",
      (event) => {
        const value = Number((event.target as HTMLInputElement).value);
        if (Number.isFinite(value) && value >= 0 && value <= 30) {
          const config = structuredClone(getWorld().config);
          config.clock.timeScale = value;
          void getWorld()
            .applyRuntimeConfig(config)
            .catch((error) => toast(error.message, true));
        }
      },
    );
    element<HTMLInputElement>("state-hour").addEventListener(
      "change",
      (event) => {
        const value = Number((event.target as HTMLInputElement).value),
          world = getWorld();
        if (Number.isFinite(value) && value >= 0 && value <= 24) {
          const config = structuredClone(world.config);
          config.clock.initialHour =
            (((value -
              (world.clock.elapsedSeconds / world.config.clock.dayDuration) *
                24) %
              24) +
              24) %
            24;
          void world
            .applyRuntimeConfig(config)
            .catch((error) => toast(error.message, true));
        }
      },
    );
  }

  update(): void {
    const world = this.getWorld(),
      paused = world.clock.paused,
      metrics = world.metrics;
    element("clock-pause").innerHTML = icon(paused ? "play" : "pause");
    setTranslatedAttribute(
      element("clock-pause"),
      "aria-label",
      paused
        ? t("ui.main.resume-the-world-clock")
        : t("ui.layout.pause-the-world-clock"),
    );
    setTranslatedAttribute(
      element("world-state-toggle"),
      "title",
      t("ui.world-state.world", {
        p0: world.clock.label,
        p1: world.config.clock.timeScale,
        p2: paused ? t("ui.world-state.paused") : t("ui.world-state.running"),
      }),
    );
    setText(
      element("dynamic-stat"),
      t("ui.world-state.dynamic", {
        p0: world.state.bodies.size,
        p1: world.state.entities.size,
      }),
    );
    if (!element<HTMLDialogElement>("world-state-dialog").open) return;
    setText(
      element("state-pause"),
      paused ? t("ui.world-state.resume-world") : t("ui.layout.pause-world"),
    );
    const entities = [...world.state.entities.values()]
      .slice(-6)
      .map(
        (entity) =>
          `${entity.sleeping ? t("ui.world-state.sleeping") : t("ui.world-state.active")} · y=${entity.position.y.toFixed(2)}m · v=${Math.hypot(...Object.values(entity.linearVelocity)).toFixed(2)}m/s`,
      );
    setText(
      element("world-state-summary"),
      t("ui.world-state.world-time-tick-simulated-s-fixed-physics-rate-hz", {
        p0: world.clock.label,
        p1: world.config.clock.timeScale,
        p2: world.clock.tick,
        p3: world.clock.elapsedSeconds.toFixed(2),
        p4: world.config.physics.frequency,
        p5: world.config.physics.gravity,
        p6: metrics.activeBodies ?? 0,
        p7: metrics.sleepingBodies ?? 0,
        p8: metrics.simulationChunks ?? 0,
        p9:
          Number(metrics.impulseJoints ?? 0) +
          Number(metrics.multibodyJoints ?? 0),
        p10: metrics.pendingSteps ?? 0,
        p11: Number(metrics.stepMilliseconds ?? 0).toFixed(1),
        p12: Array.isArray(metrics.blockedAutomaticSpawns)
          ? metrics.blockedAutomaticSpawns.length
          : 0,
        p13: entities.join("\n"),
      }),
    );
  }
}
