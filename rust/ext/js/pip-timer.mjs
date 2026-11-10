// The focus round's time left in a small always-on-top window (Document
// Picture-in-Picture), so it stays in sight over other tabs and apps. It
// borrows the opener's stylesheets and palette, and reads the round from
// storage, so stopping the round anywhere closes it.
// ponytail: the window belongs to the page that opened it and closes when that
// page navigates or closes; an offscreen-owned window if that turns out to bite.

export const canFloat = () => 'documentPictureInPicture' in window;

export async function floatTimer() {
  const pip = await window.documentPictureInPicture.requestWindow({ width: 260, height: 132 });
  const doc = pip.document;
  const theme = document.documentElement.dataset.theme;
  if (theme) doc.documentElement.dataset.theme = theme;
  for (const link of document.querySelectorAll('link[rel=stylesheet]')) doc.head.append(link.cloneNode());
  doc.title = 'Focus';
  doc.body.className = 'pip-timer';
  const time = doc.createElement('p');
  time.className = 'pip-time';
  const task = doc.createElement('p');
  task.className = 'pip-task';
  doc.body.append(time, task);
  const draw = async () => {
    const { pomodoro: p } = await chrome.storage.local.get('pomodoro');
    if (!p) return pip.close();
    const s = Math.max(0, Math.ceil((p.endsAt - Date.now()) / 1000));
    time.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    const onBreak = p.phase === 'break';
    if (onBreak) doc.documentElement.dataset.phase = 'break';
    else delete doc.documentElement.dataset.phase;
    task.textContent = onBreak ? 'Break' : (p.tasks.find((t) => !t.done)?.text ?? 'Focus');
  };
  const every = setInterval(draw, 1000);
  pip.addEventListener('pagehide', () => clearInterval(every));
  await draw();
}
