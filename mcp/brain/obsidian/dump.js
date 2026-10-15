// Paste into Obsidian's developer console (Cmd+Opt+I, Console) with the vault open.
// Writes what Obsidian itself resolved to <vault>/.brain/obsidian-dump.json.
(async () => {
  const files = {};
  for (const f of app.vault.getMarkdownFiles()) {
    const c = app.metadataCache.getFileCache(f) ?? {};
    const fmTags = [].concat(c.frontmatter?.tags ?? []).map((t) => String(t).replace(/^#/, ''));
    files[f.path] = {
      headings: (c.headings ?? []).map((h) => ({ text: h.heading, level: h.level })),
      tags: [...new Set([...fmTags, ...(c.tags ?? []).map((t) => t.tag.replace(/^#/, ''))])].sort(),
      resolved: app.metadataCache.resolvedLinks[f.path] ?? {},
      unresolved: app.metadataCache.unresolvedLinks[f.path] ?? {},
    };
  }
  const obsidian = navigator.userAgent.match(/obsidian\/([\d.]+)/i)?.[1] ?? 'unknown';
  await app.vault.adapter.mkdir('.brain').catch(() => {});
  await app.vault.adapter.write('.brain/obsidian-dump.json', JSON.stringify({ obsidian, at: new Date().toISOString(), files }, null, 1));
  console.log(`brain: wrote ${Object.keys(files).length} notes to .brain/obsidian-dump.json (Obsidian ${obsidian})`);
})();
