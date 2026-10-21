import { setText } from "../../../packages/i18n/src/browser";
import { t, escapeHtml } from "../../../packages/i18n/src/index";
import { jsonBody, requestJson } from "./api";

interface EnhancementStatus {
  configured: boolean;
  defaultEnabled: boolean;
  unlocked: boolean;
  label: string;
}
interface EnhancementConfiguration {
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  timeoutSeconds: number;
  pollSeconds: number;
}

/** Per-video choice and private server credentials have separate lifetimes. */
export class PromptEnhancementPanel {
  private root = document.createElement("section");
  private initialized = false;
  private busy = false;
  private at = <T extends HTMLElement>(id: string) =>
    this.root.querySelector(`#${id}`) as T;

  constructor() {
    this.root.className = "prompt-enhancement";
    this.root.innerHTML = `<div class="enhancement-toggle"><label class="agent-check"><input id="prompt-enhancement-enabled" type="checkbox" disabled/><span data-i18n="ui.prompt-enhancement.enhance-the-prompt-before-generation">${escapeHtml(t("ui.prompt-enhancement.enhance-the-prompt-before-generation"))}</span></label><span id="enhancement-connection" class="render-note"><span data-i18n="ui.prompt-enhancement.loading-service-settings">${escapeHtml(t("ui.prompt-enhancement.loading-service-settings"))}</span></span></div>
      <details id="enhancement-settings" class="enhancement-settings"><summary><span data-i18n="ui.prompt-enhancement.prompt-enhancement-settings">${escapeHtml(t("ui.prompt-enhancement.prompt-enhancement-settings"))}</span></summary>
      <p class="render-note"><span data-i18n="ui.prompt-enhancement.minimax-h3-context-ir-reads-this-low-poly-video">${escapeHtml(t("ui.prompt-enhancement.minimax-h3-context-ir-reads-this-low-poly-video"))}</span></p>
      <form id="enhancement-unlock-form" hidden><label><span data-i18n="ui.agent-settings.server-access-token">${escapeHtml(t("ui.agent-settings.server-access-token"))}</span><input id="enhancement-access-token" type="password" autocomplete="off" maxlength="512" required/></label><p class="render-note"><span data-i18n="ui.prompt-enhancement.use-the-code-agent-server-access-token-you-do">${escapeHtml(t("ui.prompt-enhancement.use-the-code-agent-server-access-token-you-do"))}</span> <code>uv run python -m chrona.authoring.agents.access</code> <span data-i18n="ui.prompt-enhancement.to-obtain-the-token">${escapeHtml(t("ui.prompt-enhancement.to-obtain-the-token"))}</span></p><button class="button" type="submit"><span data-i18n="ui.agent-settings.unlock-settings">${escapeHtml(t("ui.agent-settings.unlock-settings"))}</span></button></form>
      <form id="enhancement-settings-form" hidden>
      <label><span data-i18n="ui.agent-settings.api-url">${escapeHtml(t("ui.agent-settings.api-url"))}</span><input id="enhancement-base-url" type="url" maxlength="2000" required spellcheck="false"/></label>
      <p class="render-note"><span data-i18n="ui.prompt-enhancement.china-https-api-minimax-cn-international-https-api-minimax">${escapeHtml(t("ui.prompt-enhancement.china-https-api-minimax-cn-international-https-api-minimax"))}</span></p>
      <label><span data-i18n="ui.prompt-enhancement.enhancement-model">${escapeHtml(t("ui.prompt-enhancement.enhancement-model"))}</span><input id="enhancement-model" maxlength="200" required spellcheck="false"/></label>
      <label><span data-i18n="ui.agent-settings.api-key">${escapeHtml(t("ui.agent-settings.api-key"))}</span><input id="enhancement-api-key" type="password" autocomplete="off" maxlength="4096" placeholder="${escapeHtml(t("ui.prompt-enhancement.leave-blank-to-keep-the-server-s-saved-key"))}" data-i18n-placeholder="ui.prompt-enhancement.leave-blank-to-keep-the-server-s-saved-key"/></label><p id="enhancement-key-state" class="render-note"></p>
      <label class="agent-check"><input id="enhancement-clear-key" type="checkbox"/><span data-i18n="ui.prompt-enhancement.clear-the-saved-key">${escapeHtml(t("ui.prompt-enhancement.clear-the-saved-key"))}</span></label>
      <label class="agent-check"><input id="enhancement-default" type="checkbox"/><span data-i18n="ui.prompt-enhancement.enable-enhancement-by-default-for-new-tasks">${escapeHtml(t("ui.prompt-enhancement.enable-enhancement-by-default-for-new-tasks"))}</span></label>
      <div class="agent-limits"><label><span data-i18n="ui.agent-settings.total-timeout-seconds">${escapeHtml(t("ui.agent-settings.total-timeout-seconds"))}</span><input id="enhancement-timeout" type="number" min="15" max="900" required/></label><label><span data-i18n="ui.prompt-enhancement.polling-interval-seconds">${escapeHtml(t("ui.prompt-enhancement.polling-interval-seconds"))}</span><input id="enhancement-poll" type="number" min="1" max="30" step="0.5" required/></label></div>
      <div class="agent-buttons"><button id="enhancement-save" class="button" type="submit"><span data-i18n="ui.agent-settings.save-settings">${escapeHtml(t("ui.agent-settings.save-settings"))}</span></button><button id="enhancement-test" class="button" type="button"><span data-i18n="ui.prompt-enhancement.test-enhancement-calls-the-api">${escapeHtml(t("ui.prompt-enhancement.test-enhancement-calls-the-api"))}</span></button></div></form>
      <p id="enhancement-status" class="render-note" role="status"></p><details id="enhancement-preview" hidden><summary><span data-i18n="ui.prompt-enhancement.enhancement-test-result">${escapeHtml(t("ui.prompt-enhancement.enhancement-test-result"))}</span></summary><pre id="enhancement-preview-text"></pre></details></details>`;
    document
      .getElementById("render-prompt")!
      .closest("label")!
      .before(this.root);
    this.at<HTMLDetailsElement>("enhancement-settings").addEventListener(
      "toggle",
      () => {
        if (this.at<HTMLDetailsElement>("enhancement-settings").open)
          void this.load().catch((error) => this.status(error.message, true));
      },
    );
    this.at("enhancement-unlock-form").onsubmit = (event) => {
      event.preventDefault();
      void this.action(async () => {
        await requestJson(
          "/api/content/agent/unlock",
          jsonBody({
            accessToken: this.at<HTMLInputElement>("enhancement-access-token")
              .value,
          }),
        );
        this.at<HTMLInputElement>("enhancement-access-token").value = "";
        await this.load();
      });
    };
    this.at("enhancement-settings-form").onsubmit = (event) => {
      event.preventDefault();
      void this.action(async () => {
        const value = await requestJson<EnhancementConfiguration>(
          "/api/render/prompt-enhancement",
          { ...jsonBody(this.payload()), method: "PUT" },
        );
        this.fill(value);
        await this.refresh();
        this.status(
          t(
            "ui.prompt-enhancement.settings-saved-use-the-switch-above-to-enable-enhancement",
          ),
        );
      });
    };
    this.at("enhancement-test").onclick = () =>
      void this.action(async () => {
        this.status(
          t(
            "ui.prompt-enhancement.calling-the-enhancement-service-and-waiting-for-the-result",
          ),
        );
        const value = await requestJson<{
          prompt: string;
          model: string;
          latencyMs: number;
        }>("/api/render/prompt-enhancement/test", jsonBody(this.payload()));
        setText(this.at("enhancement-preview-text"), value.prompt);
        this.at("enhancement-preview").hidden = false;
        this.status(
          t(
            "ui.prompt-enhancement.enhanced-seconds-the-test-does-not-save-settings-or",
            { p0: value.model, p1: (value.latencyMs / 1000).toFixed(1) },
          ),
        );
      });
    document.getElementById("render-dialog")!.addEventListener("close", () => {
      this.at<HTMLInputElement>("enhancement-access-token").value = "";
      this.at<HTMLInputElement>("enhancement-api-key").value = "";
    });
    document
      .getElementById("video-settings-toggle")!
      .addEventListener(
        "click",
        () => void this.refresh().catch(() => undefined),
      );
    void this.refresh().catch(() => {
      setText(
        this.at("enhancement-connection"),
        t("ui.prompt-enhancement.enhancement-service-unavailable"),
      );
    });
  }

  get enabled(): boolean {
    return this.at<HTMLInputElement>("prompt-enhancement-enabled").checked;
  }

  private status(text: string, error = false): void {
    setText(this.at("enhancement-status"), text);
    this.at("enhancement-status").classList.toggle("error", error);
  }

  private async refresh(): Promise<EnhancementStatus> {
    const value = await requestJson<EnhancementStatus>(
      "/api/render/prompt-enhancement/status",
    );
    const toggle = this.at<HTMLInputElement>("prompt-enhancement-enabled");
    if (!this.initialized)
      toggle.checked = value.configured && value.defaultEnabled;
    this.initialized = true;
    toggle.disabled = !value.configured || !value.unlocked;
    if (!value.configured || !value.unlocked) toggle.checked = false;
    setText(
      this.at("enhancement-connection"),
      !value.configured
        ? t("ui.prompt-enhancement.api-not-configured")
        : value.unlocked
          ? value.label
          : t("ui.prompt-enhancement.unlock-to-use"),
    );
    return value;
  }

  private async load(): Promise<void> {
    const status = await this.refresh();
    this.at("enhancement-unlock-form").hidden = status.unlocked;
    this.at("enhancement-settings-form").hidden = !status.unlocked;
    if (!status.unlocked) {
      this.status(
        t(
          "ui.prompt-enhancement.unlock-to-save-keys-and-call-the-enhancement-service",
        ),
      );
      return;
    }
    this.fill(
      await requestJson<EnhancementConfiguration>(
        "/api/render/prompt-enhancement",
      ),
    );
    this.status(
      t(
        "ui.prompt-enhancement.keys-are-stored-only-on-the-server-your-minimax",
      ),
    );
  }

  private fill(value: EnhancementConfiguration): void {
    this.at<HTMLInputElement>("enhancement-base-url").value = value.baseUrl;
    this.at<HTMLInputElement>("enhancement-model").value = value.model;
    this.at<HTMLInputElement>("enhancement-api-key").value = "";
    this.at<HTMLInputElement>("enhancement-clear-key").checked = false;
    this.at<HTMLInputElement>("enhancement-default").checked = value.enabled;
    this.at<HTMLInputElement>("enhancement-timeout").value = String(
      value.timeoutSeconds,
    );
    this.at<HTMLInputElement>("enhancement-poll").value = String(
      value.pollSeconds,
    );
    setText(
      this.at("enhancement-key-state"),
      value.hasApiKey
        ? t("ui.prompt-enhancement.a-key-is-saved-on-the-server-and-is")
        : t("ui.prompt-enhancement.no-key-configured"),
    );
  }

  private payload() {
    return {
      enabled: this.at<HTMLInputElement>("enhancement-default").checked,
      baseUrl: this.at<HTMLInputElement>("enhancement-base-url").value.trim(),
      model: this.at<HTMLInputElement>("enhancement-model").value.trim(),
      apiKey:
        this.at<HTMLInputElement>("enhancement-api-key").value || undefined,
      clearApiKey: this.at<HTMLInputElement>("enhancement-clear-key").checked,
      timeoutSeconds: Number(
        this.at<HTMLInputElement>("enhancement-timeout").value,
      ),
      pollSeconds: Number(this.at<HTMLInputElement>("enhancement-poll").value),
    };
  }

  private async action(work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.root
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((button) => (button.disabled = true));
    try {
      await work();
    } catch (error) {
      this.status((error as Error).message, true);
    } finally {
      this.busy = false;
      this.root
        .querySelectorAll<HTMLButtonElement>("button")
        .forEach((button) => (button.disabled = false));
    }
  }
}
