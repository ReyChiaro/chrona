import {
  setTranslatedAttribute,
  setText,
} from "../../../packages/i18n/src/browser";
import { t, escapeHtml } from "../../../packages/i18n/src/index";
import type {
  AgentConfiguration,
  AgentStatus,
} from "../../../packages/protocol/src/agent";
import { jsonBody, requestJson } from "./api";

/** Owner unlock is separate from provider credentials; neither is saved by the browser. */
export class AgentSettingsPanel {
  private dialog = document.createElement("dialog");
  private value?: AgentConfiguration;
  private busy = false;
  private at = <T extends HTMLElement>(id: string) =>
    this.dialog.querySelector(`#${id}`) as T;

  constructor(
    private changed: (status: AgentStatus) => void,
    private afterClose: () => void,
  ) {
    this.dialog.id = "agent-settings";
    this.dialog.className = "agent-settings";
    setTranslatedAttribute(
      this.dialog,
      "aria-label",
      t("ui.agent-settings.code-agent-settings"),
    );
    this.dialog.innerHTML = `<div class="dialog-heading"><h2><span data-i18n="ui.agent-settings.code-agent">${escapeHtml(t("ui.agent-settings.code-agent"))}</span></h2><button id="agent-settings-close" class="icon-button" aria-label="${escapeHtml(t("ui.agent-settings.close-agent-settings"))}" data-i18n-aria-label="ui.agent-settings.close-agent-settings">×</button></div>
      <p class="agent-note"><span data-i18n="ui.agent-settings.connect-a-chat-completions-api-with-tool-calling-to">${escapeHtml(t("ui.agent-settings.connect-a-chat-completions-api-with-tool-calling-to"))}</span></p>
      <form id="agent-unlock-form" hidden><label><span data-i18n="ui.agent-settings.server-access-token">${escapeHtml(t("ui.agent-settings.server-access-token"))}</span><input id="agent-access-token" type="password" autocomplete="off" maxlength="512" required/></label><p class="agent-note"><span data-i18n="ui.agent-settings.unlock-settings-before-configuring-the-service-in-the-server">${escapeHtml(t("ui.agent-settings.unlock-settings-before-configuring-the-service-in-the-server"))}</span> <code>uv run python -m chrona.authoring.agents.access</code> <span data-i18n="ui.agent-settings.to-obtain-the-access-token-this-is-separate-from">${escapeHtml(t("ui.agent-settings.to-obtain-the-access-token-this-is-separate-from"))}</span></p><button class="button primary" type="submit"><span data-i18n="ui.agent-settings.unlock-settings">${escapeHtml(t("ui.agent-settings.unlock-settings"))}</span></button></form>
      <form id="agent-settings-form" hidden><label class="agent-check"><input id="agent-enabled" type="checkbox"/><span data-i18n="ui.agent-settings.use-a-code-model-api">${escapeHtml(t("ui.agent-settings.use-a-code-model-api"))}</span></label>
      <label><span data-i18n="ui.agent-settings.api-url">${escapeHtml(t("ui.agent-settings.api-url"))}</span><input id="agent-base-url" type="url" placeholder="https://your-provider.example/v1" maxlength="2000" spellcheck="false"/></label>
      <label><span data-i18n="ui.agent-settings.model-name">${escapeHtml(t("ui.agent-settings.model-name"))}</span><input id="agent-model" type="text" placeholder="${escapeHtml(t("ui.agent-settings.enter-the-provider-s-model-id"))}" maxlength="200" autocomplete="off" spellcheck="false" data-i18n-placeholder="ui.agent-settings.enter-the-provider-s-model-id"/></label>
      <label><span data-i18n="ui.agent-settings.api-key">${escapeHtml(t("ui.agent-settings.api-key"))}</span><input id="agent-api-key" type="password" autocomplete="off" maxlength="4096" placeholder="${escapeHtml(t("ui.agent-settings.leave-blank-to-keep-the-saved-key-optional-for"))}" data-i18n-placeholder="ui.agent-settings.leave-blank-to-keep-the-saved-key-optional-for"/></label><p id="agent-key-state" class="agent-note"></p>
      <label class="agent-check"><input id="agent-clear-key" type="checkbox"/><span data-i18n="ui.agent-settings.clear-the-saved-api-key">${escapeHtml(t("ui.agent-settings.clear-the-saved-api-key"))}</span></label>
      <div class="agent-limits"><label><span data-i18n="ui.agent-settings.total-timeout-seconds">${escapeHtml(t("ui.agent-settings.total-timeout-seconds"))}</span><input id="agent-timeout" type="number" min="15" max="300" value="180" required/></label><label><span data-i18n="ui.agent-settings.maximum-tool-rounds">${escapeHtml(t("ui.agent-settings.maximum-tool-rounds"))}</span><input id="agent-rounds" type="number" min="2" max="16" value="8" required/></label></div>
      <p class="agent-note"><span data-i18n="ui.agent-settings.keys-are-stored-only-on-the-server-testing-makes">${escapeHtml(t("ui.agent-settings.keys-are-stored-only-on-the-server-testing-makes"))}</span></p>
      <div class="agent-buttons"><button type="submit" id="agent-save" class="button primary"><span data-i18n="ui.agent-settings.save-settings">${escapeHtml(t("ui.agent-settings.save-settings"))}</span></button><button type="button" id="agent-test" class="button"><span data-i18n="ui.agent-settings.test-connection">${escapeHtml(t("ui.agent-settings.test-connection"))}</span></button><button type="button" id="agent-lock" class="text-button"><span data-i18n="ui.agent-settings.lock">${escapeHtml(t("ui.agent-settings.lock"))}</span></button></div></form>
      <p id="agent-settings-status" role="status" class="agent-note"></p>`;
    document.body.append(this.dialog);
    this.at("agent-settings-close").onclick = () => this.close();
    this.dialog.onclose = () => {
      this.at<HTMLInputElement>("agent-access-token").value = "";
      this.at<HTMLInputElement>("agent-api-key").value = "";
      this.afterClose();
    };
    this.at("agent-unlock-form").onsubmit = (e) => {
      e.preventDefault();
      void this.unlock();
    };
    this.at("agent-settings-form").onsubmit = (e) => {
      e.preventDefault();
      void this.save();
    };
    this.at("agent-test").onclick = () => void this.test();
    this.at("agent-lock").onclick = () => void this.lock();
    void this.refresh().catch(() => undefined);
  }
  async refresh(): Promise<AgentStatus> {
    const status = await requestJson<AgentStatus>("/api/content/agent/status");
    this.changed(status);
    return status;
  }
  async open(): Promise<void> {
    if (!this.dialog.open) this.dialog.showModal();
    setText(
      this.at("agent-settings-status"),
      t("ui.agent-settings.loading-agent-settings"),
    );
    try {
      await this.load();
    } catch (error) {
      this.status((error as Error).message, true);
    }
  }
  close(): void {
    if (this.dialog.open) this.dialog.close();
  }
  private status(message: string, error = false): void {
    const node = this.at("agent-settings-status");
    setText(node, message);
    node.classList.toggle("error", error);
  }
  private async load(): Promise<void> {
    const status = await this.refresh();
    this.at("agent-unlock-form").hidden = status.unlocked;
    this.at("agent-settings-form").hidden = !status.unlocked;
    if (!status.unlocked) {
      this.value = undefined;
      this.status(
        t("ui.agent-settings.unlock-to-configure-the-api-and-use-a-code"),
      );
      this.at("agent-access-token").focus();
      return;
    }
    this.value = await requestJson<AgentConfiguration>("/api/content/agent");
    this.fill(this.value);
    this.status(
      this.value.mode === "api"
        ? t("ui.agent-settings.using", { p0: this.value.model })
        : t("ui.agent-settings.code-agent-unavailable"),
    );
  }
  private fill(value: AgentConfiguration): void {
    this.at<HTMLInputElement>("agent-enabled").checked =
      value.enabled && value.configured;
    this.at<HTMLInputElement>("agent-base-url").value = value.baseUrl;
    this.at<HTMLInputElement>("agent-model").value = value.model;
    this.at<HTMLInputElement>("agent-api-key").value = "";
    this.at<HTMLInputElement>("agent-clear-key").checked = false;
    this.at<HTMLInputElement>("agent-timeout").value = String(
      value.timeoutSeconds,
    );
    this.at<HTMLInputElement>("agent-rounds").value = String(value.maxRounds);
    setText(
      this.at("agent-key-state"),
      value.hasApiKey
        ? t("ui.agent-settings.a-key-is-saved-on-the-server-and-is")
        : t("ui.agent-settings.no-key-is-saved-leave-blank-for-a-local"),
    );
  }
  private payload() {
    return {
      enabled: this.at<HTMLInputElement>("agent-enabled").checked,
      baseUrl: this.at<HTMLInputElement>("agent-base-url").value.trim(),
      model: this.at<HTMLInputElement>("agent-model").value.trim(),
      apiKey: this.at<HTMLInputElement>("agent-api-key").value || undefined,
      clearApiKey: this.at<HTMLInputElement>("agent-clear-key").checked,
      timeoutSeconds: Number(this.at<HTMLInputElement>("agent-timeout").value),
      maxRounds: Number(this.at<HTMLInputElement>("agent-rounds").value),
    };
  }
  private async action(work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.dialog
      .querySelectorAll<HTMLButtonElement>("button:not(#agent-settings-close)")
      .forEach((b) => (b.disabled = true));
    try {
      await work();
    } catch (error) {
      this.status((error as Error).message, true);
    } finally {
      this.busy = false;
      this.dialog
        .querySelectorAll<HTMLButtonElement>("button")
        .forEach((b) => (b.disabled = false));
    }
  }
  private async unlock(): Promise<void> {
    await this.action(async () => {
      await requestJson(
        "/api/content/agent/unlock",
        jsonBody({
          accessToken: this.at<HTMLInputElement>("agent-access-token").value,
        }),
      );
      this.at<HTMLInputElement>("agent-access-token").value = "";
      await this.load();
    });
  }
  private async save(): Promise<void> {
    await this.action(async () => {
      this.value = await requestJson<AgentConfiguration>("/api/content/agent", {
        ...jsonBody(this.payload()),
        method: "PUT",
      });
      this.fill(this.value);
      await this.refresh();
      this.status(
        this.value.mode === "api"
          ? t(
              "ui.agent-settings.code-model-enabled-new-instructions-will-use-these-settings",
            )
          : t("ui.agent-settings.code-agent-unavailable"),
      );
    });
  }
  private async test(): Promise<void> {
    await this.action(async () => {
      this.status(
        t("ui.agent-settings.testing-the-connection-and-tool-calling"),
      );
      const result = await requestJson<{ model: string; latencyMs: number }>(
        "/api/content/agent/test",
        jsonBody(this.payload()),
      );
      this.status(
        t(
          "ui.agent-settings.connected-tool-calling-available-ms-save-settings-to-apply",
          { p0: result.model, p1: result.latencyMs },
        ),
      );
    });
  }
  private async lock(): Promise<void> {
    await this.action(async () => {
      await requestJson("/api/content/agent/lock", jsonBody({}));
      await this.load();
    });
  }
}
