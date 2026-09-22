import { Icon, VoiceMark } from "../icons";
import { formatMessage, useI18n } from "../i18n";
import type { LauncherSnapshot, TabId } from "../types";
import { platformName, primaryTabs, statusLabel } from "../lib/presentation";

export function StatusDot({
  state,
}: {
  state: LauncherSnapshot["runtime"]["state"];
}) {
  return <span aria-hidden="true" className={`status-dot is-${state}`} />;
}

export function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={`switch${checked ? " is-on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span />
    </button>
  );
}

export function EmptyBridge() {
  return (
    <main className="bridge-error">
      <span className="bridge-mark">
        <VoiceMark />
      </span>
      <h1>Persona Voice</h1>
      <p>Desktop bridge unavailable · デスクトップブリッジを利用できません · 桌面桥接不可用</p>
    </main>
  );
}

export function Sidebar({
  active,
  collapsed,
  snapshot,
  onSelect,
  onInstallUpdate,
  onToggle,
}: {
  active: TabId;
  collapsed: boolean;
  snapshot: LauncherSnapshot;
  onSelect: (tab: TabId) => void;
  onInstallUpdate: () => void;
  onToggle: () => void;
}) {
  const { messages } = useI18n();
  const tabs = primaryTabs(messages);
  const updateVisible = ["available", "downloading", "installing"].includes(
    snapshot.update.status,
  );
  const updateBusy = ["downloading", "installing"].includes(
    snapshot.update.status,
  );
  const updateVersion = "version" in snapshot.update
    ? snapshot.update.version
    : null;
  return (
    <aside aria-label={messages.sidebar.ariaLabel} className="app-sidebar">
      <div className="sidebar-titlebar draggable" />
      <div className="sidebar-content">
        <div className="sidebar-toolbar">
          <button
            aria-label={messages.sidebar.openVoice}
            className="sidebar-brand"
            onClick={() => onSelect("home")}
            type="button"
          >
            <span className="brand-symbol">
              <VoiceMark />
            </span>
            <span className="brand-copy">
              <strong>Persona Voice</strong>
              <small>{messages.sidebar.localRelay}</small>
            </span>
          </button>
          <button
            aria-label={collapsed ? messages.sidebar.expand : messages.sidebar.collapse}
            className="icon-button sidebar-toggle"
            onClick={onToggle}
            title={`${collapsed ? messages.sidebar.expand : messages.sidebar.collapse} (⌘B)`}
            type="button"
          >
            <Icon name="panel" />
          </button>
        </div>
        <nav aria-label={messages.sidebar.mainNavigation} className="sidebar-nav">
          {tabs.map((tab) => (
            <button
              aria-current={active === tab.id ? "page" : undefined}
              className={`sidebar-item${active === tab.id ? " is-active" : ""}`}
              key={tab.id}
              onClick={() => onSelect(tab.id)}
              title={collapsed ? tab.label : undefined}
              type="button"
            >
              <Icon name={tab.icon} />
              <span>{tab.label}</span>
              {tab.id === "history" && snapshot.history.length > 0 ? (
                <small>{snapshot.history.length}</small>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {updateVisible ? (
            <button
              className="sidebar-item is-update"
              disabled={updateBusy || snapshot.runtime.state !== "stopped"}
              onClick={onInstallUpdate}
              title={collapsed && updateVersion
                ? formatMessage(messages.sidebar.updateTo, { version: updateVersion })
                : undefined}
              type="button"
            >
              <Icon name="update" />
              <span>
                {updateBusy
                  ? messages.sidebar.updating
                  : formatMessage(messages.sidebar.updateTo, { version: updateVersion || "" })}
              </span>
            </button>
          ) : null}
          <button
            aria-current={active === "settings" ? "page" : undefined}
            className={`sidebar-item${active === "settings" ? " is-active" : ""}`}
            onClick={() => onSelect("settings")}
            title={collapsed ? messages.sidebar.settings : undefined}
            type="button"
          >
            <Icon name="settings" />
            <span>{messages.sidebar.settings}</span>
          </button>
          <div
            aria-live="polite"
            className="sidebar-runtime"
            role="status"
            title={statusLabel(snapshot, messages)}
          >
            <StatusDot state={snapshot.runtime.state} />
            <div>
              <strong>{statusLabel(snapshot, messages)}</strong>
              <small>
                {platformName(snapshot.app.platform)} · v{snapshot.app.version}
              </small>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

export function WorkspaceToolbar({
  active,
  snapshot,
}: {
  active: TabId;
  snapshot: LauncherSnapshot;
}) {
  const { messages } = useI18n();
  if (active === "visualizer") {
    return <header aria-hidden="true" className="workspace-toolbar draggable" />;
  }
  const title =
    active === "home"
      ? messages.sidebar.voice
      : active === "history"
        ? messages.sidebar.history
        : messages.sidebar.settings;
  return (
    <header className="workspace-toolbar draggable">
      <div className="workspace-title">
        <strong>{title}</strong>
      </div>
      <div aria-live="polite" className="workspace-status" role="status">
        <StatusDot state={snapshot.runtime.state} />
        <span>{statusLabel(snapshot, messages)}</span>
      </div>
    </header>
  );
}
