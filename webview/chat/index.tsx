// Defer module initialization too: a late external load after the inline fallback
// must not acquire the VS Code API twice or install duplicate listeners.
if (!(window as any).__codexElementAppReady) {
  (window as any).__codexElementAppReady = true;
  const { mount } = require("./mount") as typeof import("./mount");
  mount();
}
export {};
