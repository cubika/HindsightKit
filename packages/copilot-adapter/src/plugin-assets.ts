declare const __PROVENLOOP_PLUGIN_ASSETS__: Readonly<Record<string, string>>;

export const bundledPluginAssets = (): Readonly<Record<string, string>> => {
  if (typeof __PROVENLOOP_PLUGIN_ASSETS__ === "undefined") {
    throw new Error("In-place plugin recovery requires verified bundled plugin assets.");
  }
  return __PROVENLOOP_PLUGIN_ASSETS__;
};
