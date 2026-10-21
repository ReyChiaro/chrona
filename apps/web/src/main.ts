import {
  initializeLanguage,
  mountLanguageSelector,
} from "../../../packages/i18n/src/browser";
import {
  formatDate,
  getLocale,
  localizePayload,
  countMessage,
} from "../../../packages/i18n/src/index";
import {
  setText,
  setRawText,
  setTranslatedAttribute,
} from "../../../packages/i18n/src/browser";
import { t } from "../../../packages/i18n/src/index";
import "./style.css";
import {
  configSchema,
  DEFAULT_CONFIG,
  GENERATOR_VERSION,
  generationSignature,
  SETTING_FIELDS,
  type WorldConfig,
} from "../../../packages/protocol/src/config";
import {
  snapshotSchema,
  type WorldSnapshot,
} from "../../../packages/protocol/src/contracts";
import { IntegrationRegistry } from "./integrations/providers";
import { WorldRuntime } from "../../../packages/adapters/src/runtime/client";
import { WorldView } from "../../../packages/viewer/src/world-view";
import { MapView } from "../../../packages/viewer/src/map-view";
import { RoamInput } from "./input";
import { persistence } from "./persistence";
import { icon, layout } from "./layout";
import { VideoWorkspace } from "./video-workspace";
import { WorldStatePanel } from "./world-state";
import { ContentStudio } from "./content-studio";

const element = <T extends HTMLElement>(id: string): T => {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing UI element: ${id}`);
  return result as T;
};
initializeLanguage();
document.querySelector("#app")!.innerHTML = layout();
mountLanguageSelector();

let runtime: WorldRuntime;
let view: WorldView;
let map: MapView;
let input: RoamInput;
let toastTimeout: ReturnType<typeof setTimeout>;
let lastAutosave = 0;
let saveInFlight: Promise<void> | null = null;
const integrations = new IntegrationRegistry();
let videoWorkspace: VideoWorkspace;
let worldStatePanel: WorldStatePanel;
let contentStudio: ContentStudio;

function toast(message: string, error = false): void {
  const target = element("toast");
  setText(target, message);
  target.hidden = false;
  target.classList.toggle("error", error);
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => (target.hidden = true), 3800);
}
function getPath(object: unknown, path: string): unknown {
  return path.split(".").reduce((value: any, key) => value[key], object);
}
function setPath(object: WorldConfig, path: string, value: unknown): void {
  const keys = path.split(".");
  let parent: any = object;
  for (const key of keys.slice(0, -1)) parent = parent[key];
  parent[keys.at(-1)!] = value;
}

function populateSettings(config: WorldConfig, applyAll = false): void {
  const container = element("settings-fields");
  container.replaceChildren();
  for (const field of SETTING_FIELDS) {
    const label = document.createElement("label");
    label.className = "setting";
    const header = document.createElement("span");
    header.className = "setting-head";
    const title = document.createElement("span");
    setText(title, field.label);
    header.append(title);
    const output = document.createElement("output");
    header.append(output);
    const control = document.createElement("input");
    control.name = field.path;
    control.type = field.kind;
    if (field.kind === "range") {
      control.min = String(field.min);
      control.max = String(field.max);
      control.step = String(field.step);
      control.value = String(getPath(config, field.path));
      const update = () => {
        const unit = "unit" in field ? field.unit : "";
        setText(output, `${control.value}${unit ? ` ${unit}` : ""}`);
        if (field.path === "loadRange") {
          const n = Number(control.value) - 1;
          setText(
            output,
            t("ui.main.rings-chunks", {
              rings: countMessage(Number(control.value), "ring"),
              chunks: countMessage(1 + 3 * n * (n + 1), "chunk"),
            }),
          );
        }
      };
      control.addEventListener("input", update);
      update();
    } else control.value = String(getPath(config, field.path));
    control.dataset.initialValue = applyAll ? "" : control.value;
    label.append(header, control);
    if ("help" in field) {
      const help = document.createElement("small");
      setText(help, field.help);
      label.append(help);
    }
    container.append(label);
  }
  (document.querySelector("[name=showHexEdges]") as HTMLInputElement).checked =
    config.presentation.showHexEdges;
}

async function replaceWorld(
  config: WorldConfig,
  saved?: WorldSnapshot,
): Promise<void> {
  if (videoWorkspace?.active)
    throw new Error(
      t(
        "ui.main.stop-camera-recording-before-changing-worlds-or-generation-rules",
      ),
    );
  contentStudio?.close(false);
  if (runtime && !runtime.readOnly) await runtime.persist(await runtime.stop());
  input?.dispose();
  map?.dispose();
  view?.dispose();
  runtime?.dispose();
  const next = await WorldRuntime.create(config, saved, persistence);
  runtime = next;
  view = new WorldView(
    runtime,
    element("global-canvas"),
    element("first-canvas"),
  );
  map = new MapView(element("map-canvas"), runtime, (text) =>
    setText(element("map-inspect"), text),
  );
  input = new RoamInput(
    element("first-canvas"),
    runtime,
    (locked) => {
      element("roam-overlay").hidden = locked;
      setText(
        element("movement-mode"),
        locked ? t("ui.main.exploring") : t("ui.main.ready-to-explore"),
      );
    },
    (message) => toast(message, true),
  );
  if (runtime.readOnly)
    setText(
      element("world-name"),
      t("ui.main.read-only", { p0: runtime.name }),
    );
  else setRawText(element("world-name"), runtime.name);
  element<HTMLButtonElement>("save-world").disabled = runtime.readOnly;
  setText(element("seed-stat"), config.seed);
  element<HTMLInputElement>("global-trail").checked =
    config.presentation.showGlobalTrail;
  element<HTMLInputElement>("map-trail").checked =
    config.presentation.showMapTrail;
  element<HTMLInputElement>("map-contours").checked =
    config.presentation.mapContours;
  element("overview-follow").classList.remove("active");
  element("overview-reset").classList.add("active");
  element("clock-pause").innerHTML = icon("pause");
  populateSettings(config);
  lastAutosave = performance.now();
}

async function saveWorld(quiet = false): Promise<void> {
  if (saveInFlight) await saveInFlight;
  const current = runtime,
    snapshot = await current.checkpoint();
  const button = element<HTMLButtonElement>("save-world");
  button.disabled = true;
  const task = current.persist(snapshot);
  saveInFlight = task;
  try {
    await task;
    if (current === runtime)
      setText(
        element("save-status"),
        t("ui.main.saved-tick", {
          p0: snapshot.tick,
          p1: formatDate(snapshot.savedAt, {
            hour: "2-digit",
            minute: "2-digit",
          }),
        }),
      );
    if (!quiet) toast(t("ui.main.world-camera-trail-and-clock-saved"));
  } finally {
    if (saveInFlight === task) saveInFlight = null;
    button.disabled = false;
  }
}

function download(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

element("save-world").addEventListener(
  "click",
  () => void saveWorld().catch((error) => toast(error.message, true)),
);
element("new-world").addEventListener(
  "click",
  () =>
    void (async () => {
      await saveWorld(true);
      const config = structuredClone(runtime.config);
      config.seed = `valley-${crypto.randomUUID().slice(0, 8)}`;
      await replaceWorld(config);
      setText(element("save-status"), t("ui.main.new-world-not-saved-yet"));
      toast(t("ui.main.the-new-valley-is-ready-the-previous-world-was"));
    })().catch((error) => toast(error.message, true)),
);
element("enter-roam").addEventListener("click", () => {
  void input.enter();
});
element("overview-reset").addEventListener("click", () => view.resetOverview());
element("overview-follow").addEventListener("click", (event) => {
  view.fitExplored = false;
  view.followCamera = !view.followCamera;
  (event.currentTarget as HTMLElement).classList.toggle(
    "active",
    view.followCamera,
  );
});
element<HTMLInputElement>("global-trail").addEventListener(
  "change",
  (event) => {
    const config = structuredClone(runtime.config);
    config.presentation.showGlobalTrail = (
      event.target as HTMLInputElement
    ).checked;
    void runtime
      .applyRuntimeConfig(config)
      .catch((error) => toast(error.message, true));
  },
);
element<HTMLInputElement>("map-trail").addEventListener("change", (event) => {
  const config = structuredClone(runtime.config);
  config.presentation.showMapTrail = (event.target as HTMLInputElement).checked;
  void runtime
    .applyRuntimeConfig(config)
    .catch((error) => toast(error.message, true));
});
element<HTMLInputElement>("map-contours").addEventListener(
  "change",
  (event) => {
    const config = structuredClone(runtime.config);
    config.presentation.mapContours = (
      event.target as HTMLInputElement
    ).checked;
    void runtime
      .applyRuntimeConfig(config)
      .catch((error) => toast(error.message, true));
  },
);
element("map-fit").addEventListener("click", () => map.fitWorld());
element("map-focus").addEventListener("click", () => map.focus());
element("clock-pause").addEventListener("click", () => {
  runtime.clock.paused = !runtime.clock.paused;
  element("clock-pause").innerHTML = icon(
    runtime.clock.paused ? "play" : "pause",
  );
  setTranslatedAttribute(
    element("clock-pause"),
    "aria-label",
    runtime.clock.paused
      ? t("ui.main.resume-the-world-clock")
      : t("ui.layout.pause-the-world-clock"),
  );
});
element("capture-frame").addEventListener("click", () => {
  const capture = view.capture();
  integrations.publish(capture.observation);
  download(
    `observation-${runtime.clock.tick}.json`,
    JSON.stringify(capture, null, 2),
    "application/json",
  );
  toast(t("ui.main.exported-the-observation-frame-and-camera-chunk-and-clock"));
});
element("settings-toggle").addEventListener("click", () => {
  const drawer = element("settings");
  drawer.hidden = !drawer.hidden;
});
element("settings-close").addEventListener(
  "click",
  () => (element("settings").hidden = true),
);
element("settings-defaults").addEventListener("click", () =>
  populateSettings(DEFAULT_CONFIG, true),
);
element("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    const candidate = structuredClone(runtime.config);
    for (const field of SETTING_FIELDS) {
      const control = (event.target as HTMLFormElement).elements.namedItem(
        field.path,
      ) as HTMLInputElement;
      if (control.value === control.dataset.initialValue) continue;
      setPath(
        candidate,
        field.path,
        field.kind === "text" ? control.value : Number(control.value),
      );
    }
    candidate.presentation.showHexEdges = (
      document.querySelector("[name=showHexEdges]") as HTMLInputElement
    ).checked;
    const config = configSchema.parse(candidate);
    if (generationSignature(config) !== generationSignature(runtime.config)) {
      await saveWorld(true);
      await replaceWorld(config);
      setText(
        element("save-status"),
        t("ui.main.world-with-new-rules-not-saved-yet"),
      );
      toast(t("ui.main.the-previous-world-was-saved-and-the-new-terrain"));
    } else {
      await runtime.applyRuntimeConfig(config);
      toast(t("ui.main.settings-updated"));
    }
    element("settings").hidden = true;
  })().catch((error) => toast(error.message, true));
});
element("load-world").addEventListener(
  "click",
  () =>
    void (async () => {
      const worlds = await persistence.list(),
        list = element("world-list");
      list.replaceChildren();
      if (!worlds.length) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        setText(
          empty,
          t("ui.main.no-saves-yet-save-a-world-to-continue-later"),
        );
        list.append(empty);
      }
      for (const world of worlds) {
        const button = document.createElement("button");
        button.className = "world-item";
        const text = document.createElement("span"),
          title = document.createElement("strong"),
          detail = document.createElement("small");
        setRawText(title, world.name);
        setText(
          detail,
          t("ui.main.chunks", {
            p0: world.chunks,
            p1: world.seed,
            p2: formatDate(world.savedAt),
          }),
        );
        text.append(title, detail);
        button.append(text);
        button.insertAdjacentHTML("beforeend", icon("arrow"));
        button.addEventListener(
          "click",
          () =>
            void (async () => {
              const saved = await persistence.load(world.id);
              if (runtime.id !== saved.id) await saveWorld(true);
              await replaceWorld(saved.config, saved);
              element<HTMLDialogElement>("world-dialog").close();
              setText(element("save-status"), t("ui.main.save-restored"));
              localStorage.setItem("chrona:last-world", saved.id);
              toast(t("ui.main.world-and-camera-position-restored"));
            })().catch((error) => toast(error.message, true)),
        );
        list.append(button);
      }
      element<HTMLDialogElement>("world-dialog").showModal();
    })().catch((error) => toast(error.message, true)),
);
element("dialog-close").addEventListener("click", () =>
  element<HTMLDialogElement>("world-dialog").close(),
);

async function start(): Promise<void> {
  const response = await fetch("/api/config");
  if (!response.ok)
    throw new Error(t("ui.main.cannot-connect-to-the-world-service"));
  const { config } = await response.json();

  let saved: WorldSnapshot | undefined;
  const requestedWorld = new URLSearchParams(location.search).get("world");
  const explicitWorld =
    requestedWorld && /^[a-zA-Z0-9_-]{1,80}$/.test(requestedWorld)
      ? requestedWorld
      : null;
  const currentBookmark = localStorage.getItem("chrona:last-world");
  const last = explicitWorld ?? currentBookmark;
  if (last) {
    try {
      saved = await persistence.load(last);
    } catch (error) {
      throw new Error(
        t("ui.main.cannot-restore-world", {
          p0: last,
          p1: (error as Error).message,
        }),
      );
    }
  }
  if (saved && saved.generatorVersion !== GENERATOR_VERSION) {
    throw new Error(
      t(
        "ui.main.the-save-generator-version-is-incompatible-explicit-migration-is",
      ),
    );
  }
  await replaceWorld(saved?.config ?? configSchema.parse(config), saved);
  if (!runtime.readOnly) await runtime.persist(await runtime.checkpoint());
  videoWorkspace = new VideoWorkspace(
    () => view,
    () => void input.enter(),
    toast,
  );
  contentStudio = new ContentStudio(
    () => view,
    () => input,
    () => saveWorld(true),
    toast,
  );
  worldStatePanel = new WorldStatePanel(
    () => runtime,
    () => saveWorld(true),
    toast,
  );
  if (saved)
    setText(element("save-status"), t("ui.main.previous-world-restored"));
  element("loading").hidden = true;

  let previous = performance.now(),
    frameCount = 0,
    sampleStart = previous,
    lastUI = 0,
    lastMap = 0;
  function frame(now: number): void {
    const delta = (now - previous) / 1000;
    previous = now;
    runtime.update(delta, input.snapshot());
    view.render(now / 1000);
    videoWorkspace.frame();
    if (integrations.hasObservers) integrations.publish(view.observation());
    if (now - lastMap > 66) {
      map.render();
      lastMap = now;
    }
    if (now - lastUI > 200) {
      const count = runtime.chunks.active.size;
      setText(element("loaded-stat"), t("ui.main.loaded", { p0: count }));
      setText(
        element("generated-stat"),
        t("ui.main.generated", { p0: runtime.chunks.records.size }),
      );
      setText(
        element("asset-stat"),
        t("ui.main.assets", { p0: runtime.chunks.assets.size }),
      );
      setText(
        element("global-cell-count"),
        t("ui.main.chunks-231", { p0: count }),
      );
      setText(element("world-clock"), runtime.clock.label);
      setText(
        element("camera-coordinates"),
        `${runtime.camera.x.toFixed(1)}, ${runtime.camera.z.toFixed(1)}`,
      );
      setText(
        element("observation-tick"),
        `TICK ${String(runtime.clock.tick).padStart(6, "0")}`,
      );
      element("overview-reset").classList.toggle("active", view.fitExplored);
      const overview = view.overviewStats();
      setTranslatedAttribute(
        element("overview-reset"),
        "title",
        t(
          "ui.main.all-explored-chunks-physics-chunks-loaded-overview-mesh-cache",
          {
            p0: overview.exploredChunks,
            p1: count,
            p2: (overview.cacheBytes / 1024 / 1024).toFixed(1),
          },
        ),
      );
      element("overview-follow").classList.toggle("active", view.followCamera);
      element("map-fit").classList.toggle("active", map.mode === "all");
      worldStatePanel.update();
      lastUI = now;
    }
    frameCount++;
    if (now - sampleStart > 1000) {
      setText(
        element("fps-stat"),
        `${Math.round((frameCount * 1000) / (now - sampleStart))} FPS`,
      );
      frameCount = 0;
      sampleStart = now;
    }
    if (
      now - lastAutosave > runtime.config.recording.autosaveSeconds * 1000 &&
      !saveInFlight &&
      !runtime.readOnly
    ) {
      lastAutosave = now;
      void saveWorld(true).catch((error) =>
        toast(t("ui.main.autosave-failed", { p0: error.message }), true),
      );
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Public, transport-neutral adapter surface; consumers receive copies, never physics ownership.
  Object.defineProperty(window, "chrona", {
    configurable: true,
    value: {
      get ready() {
        return true;
      },
      get runtime() {
        return runtime;
      },
      snapshot: () => runtime.snapshot(),
      observe: () => runtime.observation(),
      capture: () => view.capture(),
      overview: () => view.overviewStats(),
      content: {
        inspect: () => view.context(),
        install: (
          pack: import("../../../packages/protocol/src/content").ContentPackage,
          options?: Parameters<WorldRuntime["installContent"]>[1],
        ) => runtime.installContent(pack, options),
      },
      editor: {
        open: () => contentStudio.open(),
        select: (
          value:
            | import("../../../packages/protocol/src/content").SceneSelection
            | null,
        ) => contentStudio.select(value),
        pick: (x?: number, y?: number) => view.pick(x, y),
        get selection() {
          return structuredClone(view.selection);
        },
        apply: (
          plan: import("../../../packages/protocol/src/content").EditPlan,
          pack?: import("../../../packages/protocol/src/content").ContentPackage,
        ) => runtime.editor.apply(plan, pack),
      },
      save: () => saveWorld(true),
      teleport: (x: number, z: number, y?: number) => runtime.teleport(x, z, y),
      integrations,
      attachVideo: (source: string | MediaStream) => {
        const video = element<HTMLVideoElement>("video-output");
        if (typeof source === "string") video.src = source;
        else video.srcObject = source;
        video.hidden = false;
        document
          .querySelector(".video-placeholder")!
          .setAttribute("hidden", "");
        setText(
          document.querySelector(".connection-status")!,
          t("ui.main.connected"),
        );
      },
    },
  });
  window.addEventListener("pagehide", () => {
    runtime.closeSession();
  });
}

window.addEventListener("chrona-runtime-error", (event) =>
  toast((event as CustomEvent).detail, true),
);

void start().catch((error) => {
  console.error(error);
  setText(
    element("loading-message"),
    t("ui.main.check-the-services-and-browser-webgl-support-then-refresh", {
      p0: error.message,
    }),
  );
});

declare global {
  interface Window {
    chrona: {
      ready: boolean;
      runtime: WorldRuntime;
      snapshot(): WorldSnapshot;
      observe(): import("../../../packages/protocol/src/contracts").Observation;
      capture(): {
        observation: import("../../../packages/protocol/src/contracts").Observation;
        image: string;
      };
      save(): Promise<void>;
      overview(): ReturnType<WorldView["overviewStats"]>;
      content: {
        inspect: () => ReturnType<WorldView["context"]>;
        install: WorldRuntime["installContent"];
      };
      editor: {
        open(): void;
        select(
          value:
            | import("../../../packages/protocol/src/content").SceneSelection
            | null,
        ): void;
        apply: WorldRuntime["editor"]["apply"];
        pick(
          x?: number,
          y?: number,
        ):
          | import("../../../packages/protocol/src/content").SceneSelection
          | null;
        selection:
          | import("../../../packages/protocol/src/content").SceneSelection
          | null;
      };
      teleport(x: number, z: number, y?: number): void;
      integrations: IntegrationRegistry;
      attachVideo(source: string | MediaStream): void;
    };
  }
}
