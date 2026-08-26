// Unified file-save helper for all exports (DXF, PDF, CSV, project JSON).
//
// In the browser this is file-saver's saveAs (anchor-download). Inside the
// Tauri desktop shell anchor downloads do nothing in the WebView, so we use
// the native save dialog (dialog plugin) and write the bytes with the fs
// plugin instead. Tauri is detected via the injected window.__TAURI__ global
// (withGlobalTauri is enabled in tauri.conf.json), so the web build carries
// no Tauri dependency.
//
// In the Electron shell the file-saver path works as-is: anchor downloads
// become Chromium downloads, and the shell's will-download hook
// (electron/main.cjs) forces a native "Save As" dialog with the suggested
// filename and a per-extension filter — no Electron-specific code needed here.
import * as fileSaverNs from 'file-saver';

const saveAs: (blob: Blob, name: string) => void =
  (fileSaverNs as any).saveAs || (fileSaverNs as any).default?.saveAs || (fileSaverNs as any).default;

interface TauriGlobal {
  dialog: { save: (opts: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | null> };
  fs: { writeFile: (path: string, data: Uint8Array) => Promise<void> };
}

function tauri(): TauriGlobal | null {
  const t = typeof window !== 'undefined' ? (window as any).__TAURI__ : undefined;
  return t?.dialog?.save && t?.fs?.writeFile ? (t as TauriGlobal) : null;
}

export function isTauri(): boolean {
  return tauri() !== null;
}

// Filter name shown in the native dialog per file extension.
const EXT_NAMES: Record<string, string> = {
  dxf: 'DXF drawing',
  pdf: 'PDF document',
  zip: 'ZIP archive',
  csv: 'CSV spreadsheet',
  json: 'Project file',
};

// Saves the blob under the suggested name. Resolves true when the file was
// written (or the browser download started), false when the user cancelled
// the native save dialog. Rejects on write errors.
export async function saveBlob(blob: Blob, filename: string): Promise<boolean> {
  const t = tauri();
  if (!t) {
    saveAs(blob, filename);
    return true;
  }
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const path = await t.dialog.save({
    defaultPath: filename,
    filters: ext ? [{ name: EXT_NAMES[ext] ?? `${ext.toUpperCase()} file`, extensions: [ext] }] : undefined,
  });
  if (!path) return false;
  await t.fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  return true;
}
