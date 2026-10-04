import { useShallow } from 'zustand/react/shallow';
import { ASPECTS, type Aspect, type MainItem } from '../../types';
import { haptic } from '../../lib/haptics';
import { useEditor } from '../../state/store';
import { gesture, Segmented, Sheet, Slider, Swatches } from '../common';

type FitState = 'fit' | 'fill' | 'mixed';

const BG_OPTIONS: { value: 'blur' | 'color'; label: string }[] = [
  { value: 'blur', label: 'Blur' },
  { value: 'color', label: 'Color' },
];

const FIT_OPTIONS: { value: FitState; label: string }[] = [
  { value: 'fit', label: 'Fit' },
  { value: 'fill', label: 'Fill' },
];

function fitState(main: MainItem[]): FitState | null {
  if (!main.length) return null;
  const f = main[0].fit;
  return main.every((m) => m.fit === f) ? f : 'mixed';
}

export function CanvasSheet({ onClose }: { onClose: () => void }) {
  const { aspect, bg, fit } = useEditor(
    useShallow((s) => ({
      aspect: s.project?.aspect ?? '9:16',
      bg: s.project?.background ?? null,
      fit: fitState(s.project?.main ?? []),
    })),
  );
  const apply = useEditor((s) => s.apply);

  const setAspect = (a: Aspect) => {
    if (a === aspect) return;
    apply((d) => {
      d.aspect = a;
    });
    haptic('light');
  };

  const setFit = (f: FitState) => {
    if (f === 'mixed' || f === fit) return;
    apply((d) => {
      for (const m of d.main) m.fit = f;
    });
  };

  return (
    <Sheet title="Canvas" onClose={onClose}>
      <div className="aspects row" role="group" aria-label="Aspect ratio">
        {ASPECTS.map((a) => {
          const k = 32 / Math.max(a.w, a.h);
          return (
            <button key={a.id} className="aspect" aria-pressed={a.id === aspect} onClick={() => setAspect(a.id)}>
              <i style={{ width: Math.round(a.w * k), height: Math.round(a.h * k) }} aria-hidden />
              <b>{a.id}</b>
              <small>{a.hint}</small>
            </button>
          );
        })}
      </div>

      {fit && (
        <div className="field">
          <span className="field-label">Clips</span>
          <Segmented label="How clips fill the frame" value={fit} options={FIT_OPTIONS} onChange={setFit} />
          <p className="note">Fit shows each whole clip. Fill zooms in so there are no empty edges.</p>
        </div>
      )}

      {bg && (
        <div className="field">
          <span className="field-label">Background</span>
          <Segmented
            label="Background"
            value={bg.mode}
            options={BG_OPTIONS}
            onChange={(mode) =>
              apply((d) => {
                d.background.mode = mode;
              })
            }
          />
        </div>
      )}
      {bg?.mode === 'blur' && (
        <>
          <Slider
            label="Blur"
            value={bg.blur}
            min={0}
            max={1}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}`}
            {...gesture}
            onChange={(v) =>
              apply(
                (d) => {
                  d.background.blur = v;
                },
                { merge: 'bg-blur' },
              )
            }
          />
          <p className="note">Empty space around a clip shows a blurred copy of it.</p>
        </>
      )}
      {bg?.mode === 'color' && (
        <Swatches
          label="Background color"
          value={bg.color}
          onChange={(c) =>
            apply(
              (d) => {
                d.background.color = c;
              },
              { merge: 'bg-color' },
            )
          }
        />
      )}
    </Sheet>
  );
}
