import {
  formatDate,
  getLocale,
  localizePayload,
  onLocaleChange,
} from "../../../packages/i18n/src/index";
import { setText } from "../../../packages/i18n/src/browser";
import { t } from "../../../packages/i18n/src/index";
import type { RenderJob } from "../../../packages/protocol/src/render-contracts";

interface LogEntry {
  timestamp: string;
  level: string;
  event: string;
  message: string;
  jobId: string | null;
  data: Record<string, unknown>;
}
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

export class RenderLogs {
  private jobId?: string;
  private cursor = 0;
  private entries: LogEntry[] = [];
  private revision = 0;
  private busy = false;
  constructor() {
    onLocaleChange(() => {
      if (element<HTMLDetailsElement>("render-logs").open) this.reset();
    });
    element<HTMLDetailsElement>("render-logs").addEventListener(
      "toggle",
      () => {
        if (element<HTMLDetailsElement>("render-logs").open)
          void this.refresh();
      },
    );
    element("render-log-source").addEventListener("change", () => this.reset());
    element("render-log-refresh").addEventListener("click", () => this.reset());
    element("render-log-toggle").addEventListener("click", () => {
      const details = element<HTMLDetailsElement>("render-logs");
      details.open = !details.open;
      if (details.open)
        details.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    setInterval(() => {
      if (element<HTMLDetailsElement>("render-logs").open) void this.refresh();
    }, 2000);
    this.updateDownload();
  }

  setJob(job: RenderJob): void {
    if (this.jobId !== job.id) {
      this.jobId = job.id;
      element<HTMLOptionElement>("render-log-job-option").disabled = false;
      setText(
        element("render-log-job-option"),
        t("ui.render-logs.current-task", { p0: job.id.slice(0, 8) }),
      );
      element<HTMLSelectElement>("render-log-source").value = "job";
      this.reset();
    }
    setText(element("render-log-summary"), job.phase);
  }

  private base(): string {
    return element<HTMLSelectElement>("render-log-source").value === "job" &&
      this.jobId
      ? `/api/render/jobs/${this.jobId}/logs`
      : "/api/render/logs";
  }

  private updateDownload(): void {
    element<HTMLAnchorElement>("render-log-download").href =
      `${this.base()}/download`;
  }

  private reset(): void {
    this.revision++;
    this.cursor = 0;
    this.entries = [];
    this.busy = false;
    setText(element("render-log-content"), t("ui.render-logs.loading-logs"));
    this.updateDownload();
    if (element<HTMLDetailsElement>("render-logs").open) void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.busy) return;
    const revision = this.revision;
    this.busy = true;
    try {
      const response = await fetch(
        `${this.base()}?after=${this.cursor}&limit=200`,
        { headers: { "Accept-Language": getLocale() } },
      );
      if (!response.ok)
        throw new Error(
          t("ui.render-logs.the-log-service-is-temporarily-unavailable"),
        );
      const data = localizePayload(await response.json()) as {
        entries: LogEntry[];
        cursor: number;
        hasMore: boolean;
      };
      if (revision !== this.revision) return;
      this.cursor = data.cursor;
      this.entries = [...this.entries, ...data.entries].slice(-500);
      const target = element("render-log-content");
      if (data.entries.length || !this.entries.length) {
        const previousScroll = target.scrollTop;
        setText(
          target,
          this.entries.length
            ? this.entries
                .map((entry) => {
                  const time = formatDate(entry.timestamp);
                  return `[${time}] ${entry.level.toUpperCase()} ${entry.message} (${entry.event})\n${Object.keys(entry.data).length ? JSON.stringify(entry.data, null, 2) : ""}`;
                })
                .join("\n\n")
            : t("ui.render-logs.no-logs-yet-switch-to-service-logs-to-view"),
        );
        target.scrollTop = element<HTMLInputElement>("render-log-follow")
          .checked
          ? target.scrollHeight
          : previousScroll;
      }
      setText(
        element("render-log-state"),
        data.hasMore
          ? t("ui.render-logs.loading-more-history")
          : t("ui.render-logs.synced-auto-refreshing"),
      );
      if (data.hasMore) setTimeout(() => void this.refresh(), 0);
    } catch (error) {
      if (revision === this.revision)
        setText(
          element("render-log-state"),
          t("ui.render-logs.retrying-shortly", {
            p0: (error as Error).message,
          }),
        );
    } finally {
      if (revision === this.revision) this.busy = false;
    }
  }
}

export function durationLabel(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  return rounded < 60
    ? `${rounded}s`
    : `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
}

export function renderJobProgress(job: RenderJob): void {
  const meter = element<HTMLProgressElement>("render-step-progress");
  const detail = element("render-step-detail");
  const sample = job.sampling;
  const running = job.status === "running";
  meter.hidden = !running || job.stage !== "sampling" || !sample?.total;
  if (!meter.hidden) {
    meter.max = sample!.total;
    meter.value = sample!.completed;
  }
  const elapsed = job.elapsedSeconds ?? null;
  const parts = [];
  if (sample?.total)
    parts.push(
      t("ui.render-logs.sampling", {
        p0: sample.completed,
        p1: sample.total,
        p2: Math.round((sample.completed / sample.total) * 100),
      }),
    );
  if (elapsed !== null)
    parts.push(t("ui.render-logs.elapsed", { p0: durationLabel(elapsed) }));
  if (running && job.stage !== "sampling" && job.stageElapsedSeconds != null)
    parts.push(
      t("ui.render-logs.current-stage", {
        p0: durationLabel(job.stageElapsedSeconds),
      }),
    );
  if (
    running &&
    job.stage === "sampling" &&
    sample?.samplingEtaSeconds != null &&
    sample.completed > 0
  ) {
    parts.push(
      t("ui.render-logs.sampling-time-remaining-about", {
        p0: durationLabel(sample.samplingEtaSeconds),
      }),
    );
  }
  if (running && job.stage === "decoding")
    parts.push(t("ui.render-logs.decoding-sampling-complete"));
  setText(detail, parts.join(" · "));
  detail.hidden = !parts.length;
}
