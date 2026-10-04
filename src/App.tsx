import { CircleCheck, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { backDepth } from './lib/back';
import { useRoute } from './lib/route';
import { useEditor } from './state/store';
import { Progress } from './ui/common';
import { DialogHost } from './ui/dialog';
import { Editor } from './ui/Editor';
import { Home } from './ui/Home';

export function App() {
  const route = useRoute();
  useEffect(() => {
    // Escape behaves like the phone's back button: it closes the topmost sheet or dialog.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && backDepth() > 0) {
        e.preventDefault();
        history.back();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      {route.name === 'editor' ? <Editor key={route.id} id={route.id} /> : <Home />}
      <TaskPill />
      <Toasts />
      <DialogHost />
    </>
  );
}

function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  const dismiss = useEditor((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.kind === 'error' && <TriangleAlert size={18} aria-hidden />}
          {t.kind === 'success' && <CircleCheck size={18} aria-hidden />}
          <span>{t.text}</span>
        </button>
      ))}
    </div>
  );
}

function TaskPill() {
  const task = useEditor((s) => s.task);
  if (!task) return null;
  return (
    <div className="task" role="status" aria-live="polite">
      <span>{task.label}</span>
      <Progress value={task.progress} />
    </div>
  );
}
