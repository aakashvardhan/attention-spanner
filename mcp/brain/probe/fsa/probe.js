// Dev-only probe for spec build step 1. Results survive a Chrome restart in
// localStorage, so the permission check after a restart lands in the same report.
const out = document.getElementById('out');
const report = JSON.parse(localStorage.getItem('report') || 'null') || { userAgent: navigator.userAgent, steps: [] };
const show = () => {
  localStorage.setItem('report', JSON.stringify(report));
  out.textContent = JSON.stringify(report, null, 2);
};
show();

async function step(name, fn) {
  const t0 = performance.now();
  try {
    const info = (await fn()) || {};
    report.steps.push({ name, ok: true, ms: Math.round(performance.now() - t0), ...info });
  } catch (e) {
    report.steps.push({ name, ok: false, ms: Math.round(performance.now() - t0), error: `${e.name}: ${e.message}` });
  }
  show();
}

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('probe', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('handles');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function saveHandle(h) {
  const db = await idb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(h, 'dir');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function loadHandle() {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction('handles').objectStore('handles').get('dir');
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

let dir = null;
const names = async (d) => {
  const n = [];
  for await (const [name] of d.entries()) n.push(name);
  return n.sort();
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

document.getElementById('pick').onclick = () =>
  step('pick', async () => {
    dir = await showDirectoryPicker({ id: 'brain-probe', mode: 'readwrite' });
    await saveHandle(dir);
    return { folder: dir.name, permission: await dir.queryPermission({ mode: 'readwrite' }) };
  });

document.getElementById('run').onclick = async () => {
  // Every await that can fail sits inside a step, so a failure (say, permission lost after a restart) is recorded, not an unhandled rejection.
  await step('open the saved folder', async () => {
    if (!dir) dir = await loadHandle();
    if (!dir) throw new Error('pick a folder first');
  });
  if (!dir) return;
  await step('list top level', async () => ({ entries: (await names(dir)).length }));
  await step('read up to 20 notes', async () => {
    const times = [];
    const errors = [];
    const walk = async (d, depth) => {
      for await (const [name, h] of d.entries()) {
        if (times.length + errors.length >= 20) return;
        if (h.kind === 'directory' && depth < 3 && !name.startsWith('.')) await walk(h, depth + 1);
        else if (h.kind === 'file' && name.endsWith('.md')) {
          const t0 = performance.now();
          try {
            await (await h.getFile()).text();
            times.push(Math.round(performance.now() - t0));
          } catch (e) {
            errors.push(`${name}: ${e.name}`);
          }
        }
      }
    };
    await walk(dir, 0);
    return { read: times.length, medianMs: median(times), maxMs: times.length ? Math.max(...times) : null, errors };
  });
  let probe = null;
  let fh = null;
  await step('create the probe folder', async () => {
    probe = await dir.getDirectoryHandle('.brain-probe', { create: true });
    fh = await probe.getFileHandle('w.md', { create: true });
  });
  if (!fh) return;
  await step('write 1 MB through createWritable', async () => {
    const w = await fh.createWritable();
    await w.write('x'.repeat(1_000_000));
    const namesWhileOpen = await names(probe);
    const sizeBeforeClose = (await fh.getFile()).size;
    await w.close();
    return { namesWhileOpen, sizeBeforeClose, sizeAfterClose: (await fh.getFile()).size };
  });
  await step('abort leaves the old content', async () => {
    const w = await fh.createWritable();
    await w.write('partial');
    await w.abort();
    return { sizeAfterAbort: (await fh.getFile()).size, names: await names(probe) };
  });
  await step('move() on a file handle', async () => {
    if (typeof fh.move !== 'function') return { supported: false };
    await fh.move('moved.md');
    const sub = await probe.getDirectoryHandle('sub', { create: true });
    await fh.move(sub, 'moved-into-sub.md');
    return { supported: true, top: await names(probe), sub: await names(sub) };
  });
  await step('remove the probe folder', async () => {
    await dir.removeEntry('.brain-probe', { recursive: true });
    return { stillThere: (await names(dir)).includes('.brain-probe') };
  });
};

document.getElementById('again').onclick = () =>
  step('permission after restart', async () => {
    const h = await loadHandle();
    if (!h) throw new Error('no saved handle: pick a folder first');
    const before = await h.queryPermission({ mode: 'readwrite' });
    const after = before === 'granted' ? before : await h.requestPermission({ mode: 'readwrite' });
    return { before, after };
  });

document.getElementById('save').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  a.download = 'fsa-probe.json';
  a.click();
};
