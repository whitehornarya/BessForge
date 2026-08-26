// Resolve a public-folder asset path against Vite's configured base URL so
// the app works both at a site root ("/") and under a sub-path (IIS virtual
// directory, relative "./" static builds). Always pass root-style paths like
// "/textures/asphalt.png"; the leading slash is replaced with the base.
export function assetUrl(path: string): string {
  // Optional chaining keeps this importable under Node (tsx test runner),
  // where import.meta.env is undefined.
  const base = (import.meta as any).env?.BASE_URL || "/";
  return base.replace(/\/$/, "") + "/" + path.replace(/^\//, "");
}
