/**
 * Styles ship as one text sheet: the client module system has no CSS pipeline
 * for third-party plugins, so the seats install it once on first mount.
 * @module cyberself/client/styles
 */

/** Attribute marking the injected sheet, so repeat installs are inert. */
const STYLE_MARKER = 'data-cyberself-style'

const SHEET = `
.cs-grow { flex: 1 1 auto; }
.cs-summary { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cs-tag {
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--dsw-alias-text-secondary, #6b6b6b);
  background: var(--dsw-alias-surface-sunken, rgba(0, 0, 0, 0.05));
}
.cs-segments { flex: none; }
.cs-scope { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cs-muted { color: var(--dsw-alias-text-secondary, #6b6b6b); font-size: 12px; }
.cs-warn { color: var(--dsw-alias-text-warning, #b26a00); font-size: 12px; }
.cs-ok { color: var(--dsw-alias-text-success, #2f7d32); font-size: 12px; }
.cs-error { color: var(--dsw-alias-text-danger, #b3261e); font-size: 12px; white-space: pre-wrap; }
.cs-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
  padding: 12px;
  box-sizing: border-box;
}
.cs-panel-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid var(--dsw-alias-border-subtle, rgba(0, 0, 0, 0.08));
}
.cs-panel-head { display: flex; align-items: center; gap: 8px; }
.cs-panel-title { font-weight: 600; font-size: 13px; }
.cs-row { display: flex; align-items: center; gap: 8px; }
.cs-row > *:first-child { flex: 1 1 auto; }
.cs-confirm {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-subtle, rgba(0, 0, 0, 0.08));
  background: var(--dsw-alias-bg-subtle, rgba(0, 0, 0, 0.02));
}
.cs-confirm .cs-row > * { flex: none; }
.cs-progress { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.cs-progress-track { height: 4px; border-radius: 2px; background: var(--dsw-alias-border-subtle, rgba(0, 0, 0, 0.1)); overflow: hidden; }
.cs-progress-bar { height: 100%; background: var(--dsw-alias-accent, #4a6cf7); }
.cs-list { display: flex; flex-direction: column; gap: 2px; }
.cs-doc { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
.cs-doc > button { flex: none; white-space: nowrap; }
.cs-doc-main {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
  background: none;
  border: none;
  padding: 4px 6px;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  color: inherit;
  font: inherit;
}
.cs-doc-main:hover { background: var(--dsw-alias-surface-hover, rgba(0, 0, 0, 0.05)); }
.cs-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.cs-detail { display: flex; flex-direction: column; gap: 6px; border-top: 1px dashed var(--dsw-alias-border-subtle, rgba(0, 0, 0, 0.12)); padding-top: 8px; }
.cs-chunk { display: flex; flex-direction: column; gap: 2px; font-size: 12px; line-height: 1.55; }
.cs-hits { display: flex; flex-direction: column; gap: 6px; }
.cs-cite { font-size: 12px; line-height: 1.55; padding: 6px 8px; border-radius: 8px; background: var(--dsw-alias-surface-sunken, rgba(0, 0, 0, 0.03)); }
.cs-cite-head { font-weight: 600; margin-bottom: 2px; }
.cs-empty { font-size: 12px; color: var(--dsw-alias-text-secondary, #6b6b6b); padding: 8px 0; }
.cs-settings { display: flex; flex-direction: column; gap: 20px; padding: 4px 2px 24px; }
.cs-settings-head { display: flex; align-items: center; gap: 8px; }
.cs-settings-title { margin: 0; font-size: 16px; font-weight: 600; }
.cs-settings-block { display: flex; flex-direction: column; gap: 8px; }
.cs-settings-subtitle { margin: 0; font-size: 13px; font-weight: 600; }
.cs-settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.cs-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.cs-field-wide { grid-column: 1 / -1; }
.cs-field > .cs-segments { align-self: flex-start; }
.cs-settings-actions { display: flex; align-items: center; gap: 10px; }
.cs-confirm {
  padding: 8px;
  border-radius: 8px;
  background: var(--dsw-alias-surface-sunken, rgba(0, 0, 0, 0.04));
  flex-wrap: wrap;
}
.cs-path {
  font-family: var(--dsw-alias-font-mono, ui-monospace, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.cs-storage-totals { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; }
.cs-storage-row { align-items: flex-start; }
`

/** Insert the sheet once per document. */
export function installStyles(): void {
  if (document.querySelector(`style[${STYLE_MARKER}]`) !== null) return
  const style = document.createElement('style')
  style.setAttribute(STYLE_MARKER, '')
  style.textContent = SHEET
  document.head.appendChild(style)
}
