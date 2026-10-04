import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { useBack } from '../lib/back';
import { primeKeyboard } from '../lib/device';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  /** the chosen action opens a text field (keeps the iOS keyboard reachable) */
  keyboard?: boolean;
}

type Req =
  | { kind: 'confirm'; title: string; message?: string; confirm: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: 'prompt'; title: string; value: string; placeholder?: string; confirm: string; resolve: (v: string | null) => void }
  | { kind: 'menu'; title?: string; items: MenuItem[]; resolve: (v: string | null) => void };

const useDialog = create<{ req: Req | null; seq: number }>(() => ({ req: null, seq: 0 }));

function show(req: Req) {
  const prev = useDialog.getState().req;
  if (prev) cancel(prev);
  useDialog.setState((s) => ({ req, seq: s.seq + 1 }));
}

function cancel(r: Req) {
  if (r.kind === 'confirm') r.resolve(false);
  else r.resolve(null);
}

function finish(r: Req, fn: () => void) {
  if (useDialog.getState().req === r) useDialog.setState({ req: null });
  fn();
}

export function confirmDialog(o: { title: string; message?: string; confirm?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => show({ kind: 'confirm', confirm: 'OK', ...o, resolve }));
}

/** Call synchronously from a tap so the iOS keyboard can open. */
export function promptDialog(o: { title: string; value?: string; placeholder?: string; confirm?: string }): Promise<string | null> {
  primeKeyboard();
  return new Promise((resolve) => show({ kind: 'prompt', value: '', confirm: 'Save', ...o, resolve }));
}

export function menuDialog(o: { title?: string; items: MenuItem[] }): Promise<string | null> {
  return new Promise((resolve) => show({ kind: 'menu', ...o, resolve }));
}

export function DialogHost() {
  const { req, seq } = useDialog();
  if (!req) return null;
  if (req.kind === 'confirm') return <ConfirmView key={seq} r={req} />;
  if (req.kind === 'prompt') return <PromptView key={seq} r={req} />;
  return <MenuView key={seq} r={req} />;
}

function ConfirmView({ r }: { r: Extract<Req, { kind: 'confirm' }> }) {
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const close = (v: boolean) => finish(r, () => r.resolve(v));
  useBack(true, () => close(false));
  useEffect(() => cancelRef.current?.focus({ preventScroll: true }), []);
  return (
    <div className="dialog-wrap" onClick={(e) => e.target === e.currentTarget && close(false)}>
      <div className="dialog" role="alertdialog" aria-modal aria-labelledby={`${id}-t`} aria-describedby={r.message ? `${id}-m` : undefined}>
        <h2 id={`${id}-t`}>{r.title}</h2>
        {r.message && <p id={`${id}-m`}>{r.message}</p>}
        <div className="actions">
          <button ref={cancelRef} className="text-btn" onClick={() => close(false)}>
            Cancel
          </button>
          <button className={`text-btn${r.danger ? ' accent' : ''}`} onClick={() => close(true)}>
            {r.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

function PromptView({ r }: { r: Extract<Req, { kind: 'prompt' }> }) {
  const id = useId();
  const [v, setV] = useState(r.value);
  const input = useRef<HTMLInputElement>(null);
  const close = (val: string | null) => finish(r, () => r.resolve(val));
  useBack(true, () => close(null));
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.select();
  }, []);
  const ok = v.trim().length > 0;
  return (
    <div className="dialog-wrap" onClick={(e) => e.target === e.currentTarget && close(null)}>
      <form
        className="dialog"
        role="dialog"
        aria-modal
        aria-labelledby={`${id}-t`}
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) close(v.trim());
        }}
      >
        <h2 id={`${id}-t`}>{r.title}</h2>
        <input
          ref={input}
          className="input"
          value={v}
          placeholder={r.placeholder}
          aria-labelledby={`${id}-t`}
          maxLength={80}
          enterKeyHint="done"
          autoComplete="off"
          onChange={(e) => setV(e.target.value)}
        />
        <div className="actions">
          <button type="button" className="text-btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className="text-btn accent" disabled={!ok}>
            {r.confirm}
          </button>
        </div>
      </form>
    </div>
  );
}

function MenuView({ r }: { r: Extract<Req, { kind: 'menu' }> }) {
  const id = useId();
  const close = (val: string | null) => finish(r, () => r.resolve(val));
  useBack(true, () => close(null));
  return (
    <>
      <div className="scrim menu-scrim" aria-hidden onClick={() => close(null)} />
      <div className="sheet menu-sheet" role="dialog" aria-modal aria-labelledby={r.title ? `${id}-t` : undefined} aria-label={r.title ? undefined : 'Options'}>
        {r.title && (
          <div className="sheet-head">
            <h2 id={`${id}-t`}>{r.title}</h2>
          </div>
        )}
        <div className="list" style={{ padding: r.title ? '0 0 8px' : '8px 0' }}>
          {r.items.map((it) => (
            <button
              key={it.id}
              className={`menu-item${it.danger ? ' danger' : ''}`}
              onClick={() => {
                if (it.keyboard) primeKeyboard();
                close(it.id);
              }}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
          <button className="menu-item" onClick={() => close(null)}>
            <span className="dim">Cancel</span>
          </button>
        </div>
      </div>
    </>
  );
}
