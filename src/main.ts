import { App, Notice, Platform, Plugin, PluginSettingTab, SettingDefinitionItem, normalizePath, requestUrl, TFolder } from "obsidian";
import { Envelope, generateKeys, importPrivateKey, openEnvelope } from "./crypto";

const DEFAULT_SERVER = "https://obsidian.nooka.pro";
const MAX_REMEMBERED_IDS = 300;

interface NookaSettings {
  serverUrl: string;
  folder: string;
  intervalMinutes: number;
  token: string;
  publicKey: string;
  privateKeyJwk: JsonWebKey | null;
  deliveredIds: string[];
}

interface PendingItem {
  id: string;
  envelope: Envelope;
}

const DEFAULT_SETTINGS: NookaSettings = {
  serverUrl: DEFAULT_SERVER,
  folder: "Nooka Inbox",
  intervalMinutes: 5,
  token: "",
  publicKey: "",
  privateKeyJwk: null,
  deliveredIds: [],
};

// Keep one path segment; the server sanitizes too, this is defence in depth.
function safeName(name: string): string {
  const base = String(name || "")
    .replace(/[\\/:*?"<>|#^[\]]|\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .replace(/\.md$/i, "")
    .slice(0, 120)
    .trim();
  return base || "Note";
}

export default class NookaInboxPlugin extends Plugin {
  settings: NookaSettings = { ...DEFAULT_SETTINGS };
  private syncing = false;
  private intervalId: number | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new NookaSettingTab(this.app, this));
    this.addCommand({ id: "sync-now", name: "Забрать заметки сейчас", callback: () => this.sync(true) });
    this.app.workspace.onLayoutReady(() => this.sync(false));
    this.scheduleSync();
  }

  scheduleSync() {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    const minutes = Math.max(1, Number(this.settings.intervalMinutes) || 5);
    this.intervalId = window.setInterval(() => this.sync(false), minutes * 60 * 1000);
    this.registerInterval(this.intervalId);
  }

  async loadSettings() {
    const saved = (await this.loadData()) as Partial<NookaSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private api(path: string) {
    return this.settings.serverUrl.replace(/\/$/, "") + path;
  }

  async pair(code: string) {
    // Reuse keys if they already exist (e.g. data.json synced from another device of this vault),
    // so every device of one vault can decrypt the same queue.
    if (!this.settings.privateKeyJwk || !this.settings.publicKey) {
      const keys = await generateKeys();
      this.settings.publicKey = keys.publicKey;
      this.settings.privateKeyJwk = keys.privateKeyJwk;
      await this.saveSettings();
    }
    const res = await requestUrl({
      url: this.api("/obsidian/pair"),
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        code: code.trim(),
        public_key: this.settings.publicKey,
        device_name: Platform.isMobile ? "Obsidian mobile" : "Obsidian desktop",
      }),
      throw: false,
    });
    if (res.status !== 200) {
      const msg = res.status === 429 ? "Слишком много попыток, подождите 10 минут" : "Код неверный или истёк — запросите новый командой /obsidian в боте";
      throw new Error(msg);
    }
    const { token } = res.json as { token?: unknown };
    if (typeof token !== "string" || !token) throw new Error("Сервер вернул неожиданный ответ, попробуйте позже");
    this.settings.token = token;
    await this.saveSettings();
    new Notice("Nooka: подключено ✅");
    await this.sync(true);
  }

  // Revokes this device's token on the server (best effort), then forgets token and keys locally.
  // Keys live in data.json, so with a synced .obsidian folder this disconnects the vault everywhere.
  async disconnect() {
    if (this.settings.token) {
      await requestUrl({
        url: this.api("/obsidian/revoke"),
        method: "POST",
        headers: { Authorization: `Bearer ${this.settings.token}` },
        throw: false,
      }).catch(() => null);
    }
    this.settings.token = "";
    this.settings.publicKey = "";
    this.settings.privateKeyJwk = null;
    this.settings.deliveredIds = [];
    await this.saveSettings();
  }

  async sync(manual: boolean) {
    if (!this.settings.token || !this.settings.privateKeyJwk || this.syncing) return;
    this.syncing = true;
    try {
      const res = await requestUrl({
        url: this.api("/obsidian/pending"),
        headers: { Authorization: `Bearer ${this.settings.token}` },
        throw: false,
      });
      if (res.status === 401) {
        this.settings.token = "";
        await this.saveSettings();
        new Notice("Nooka: устройство отключено. Подключите заново в настройках плагина.");
        return;
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);

      const { items: raw } = res.json as { items?: unknown };
      const items: PendingItem[] = Array.isArray(raw) ? (raw as PendingItem[]) : [];
      const key = await importPrivateKey(this.settings.privateKeyJwk);
      const acked: string[] = [];
      let created = 0;

      for (const item of items) {
        if (this.settings.deliveredIds.includes(item.id)) {
          acked.push(item.id); // written earlier, previous ack was lost
          continue;
        }
        let note;
        try {
          note = await openEnvelope(key, item.envelope);
        } catch {
          continue; // not for this key: never write, never ack
        }
        await this.writeNote(note.filename, note.markdown);
        this.rememberDelivered(item.id);
        acked.push(item.id);
        created++;
      }
      if (created) await this.saveSettings();

      if (acked.length) {
        await requestUrl({
          url: this.api("/obsidian/ack"),
          method: "POST",
          contentType: "application/json",
          headers: { Authorization: `Bearer ${this.settings.token}` },
          body: JSON.stringify({ ids: acked }),
          throw: false,
        });
      }
      if (created) new Notice(`Nooka: новых заметок — ${created}`);
      else if (manual) new Notice("Nooka: новых заметок нет");
    } catch (e) {
      console.error("[nooka-inbox] sync failed", e);
      if (manual) new Notice("Nooka: не удалось забрать заметки, попробуйте позже");
    } finally {
      this.syncing = false;
    }
  }

  private rememberDelivered(id: string) {
    this.settings.deliveredIds.push(id);
    if (this.settings.deliveredIds.length > MAX_REMEMBERED_IDS) {
      this.settings.deliveredIds = this.settings.deliveredIds.slice(-MAX_REMEMBERED_IDS);
    }
  }

  private async writeNote(filename: string, markdown: string) {
    const folder = normalizePath(this.settings.folder || DEFAULT_SETTINGS.folder);
    const existing = this.app.vault.getAbstractFileByPath(folder);
    if (!existing) await this.app.vault.createFolder(folder);
    else if (!(existing instanceof TFolder)) throw new Error(`${folder} is not a folder`);

    const base = safeName(filename);
    let path = normalizePath(`${folder}/${base}.md`);
    for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) {
      path = normalizePath(`${folder}/${base} ${n}.md`);
    }
    await this.app.vault.create(path, markdown);
  }
}

class NookaSettingTab extends PluginSettingTab {
  private code = "";

  constructor(app: App, private plugin: NookaInboxPlugin) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const connected = () => Boolean(this.plugin.settings.token);
    return [
      {
        name: "Код подключения",
        desc: "Отправьте боту @n8n_nooka_bot команду /obsidian и вставьте код сюда.",
        aliases: ["nooka", "code", "connect"],
        visible: () => !connected(),
        render: (setting) => {
          setting
            .addText((t) => t.setPlaceholder("Код из бота").setValue(this.code).onChange((v) => (this.code = v)))
            .addButton((b) =>
              b.setButtonText("Подключить").setCta().onClick(async () => {
                b.setDisabled(true);
                try {
                  await this.plugin.pair(this.code);
                  this.code = "";
                  this.update();
                } catch (e) {
                  new Notice(`Nooka: ${(e as Error).message}`);
                  b.setDisabled(false);
                }
              }),
            );
        },
      },
      {
        name: "Подключено ✅",
        desc: "Заметки из бота приходят в папку ниже. Отключить все устройства можно командой /obsidian_off в боте.",
        visible: connected,
        render: (setting) => {
          setting
            .addButton((b) => b.setButtonText("Забрать сейчас").onClick(() => this.plugin.sync(true)))
            .addButton((b) =>
              b.setButtonText("Отключить это устройство").setDestructive().onClick(async () => {
                await this.plugin.disconnect();
                this.update();
              }),
            );
        },
      },
      {
        name: "Папка для заметок",
        control: { type: "text", key: "folder", placeholder: DEFAULT_SETTINGS.folder, defaultValue: DEFAULT_SETTINGS.folder },
      },
      {
        name: "Проверять каждые (минут)",
        control: { type: "number", key: "intervalMinutes", min: 1, max: 120, defaultValue: DEFAULT_SETTINGS.intervalMinutes },
      },
    ];
  }

  getControlValue(key: string): unknown {
    return this.plugin.settings[key as keyof NookaSettings];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    if (key === "folder") {
      s.folder = (typeof value === "string" ? value.trim() : "") || DEFAULT_SETTINGS.folder;
    } else if (key === "intervalMinutes") {
      s.intervalMinutes = Math.max(1, Math.min(120, Math.round(Number(value)) || DEFAULT_SETTINGS.intervalMinutes));
      this.plugin.scheduleSync();
    } else {
      return;
    }
    await this.plugin.saveSettings();
  }
}
