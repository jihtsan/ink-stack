import { useEffect, useState } from "react";
import type { DashboardDraft } from "./types";

interface CanvasInspectorProps {
  dashboard: DashboardDraft;
  onChange(dashboard: DashboardDraft): void;
}

export function CanvasInspector({ dashboard, onChange }: CanvasInspectorProps) {
  const [timeZoneDraft, setTimeZoneDraft] = useState(dashboard.timeZone);

  useEffect(() => {
    setTimeZoneDraft(dashboard.timeZone);
  }, [dashboard.timeZone]);

  function commitTimeZone() {
    const next = timeZoneDraft.trim();
    if (next && next !== dashboard.timeZone) {
      onChange({ ...dashboard, timeZone: next });
    }
  }

  return (
    <section className="inspector-section">
      <SectionTitle title="画布" />
      <TextInput label="名称" value={dashboard.name} onChange={(name) => onChange({ ...dashboard, name })} />
      <label>
        时区
        <input
          list="inkstack-time-zones"
          value={timeZoneDraft}
          onBlur={commitTimeZone}
          onChange={(event) => setTimeZoneDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
        />
      </label>
      <datalist id="inkstack-time-zones">
        <option value="Asia/Shanghai" />
        <option value="Asia/Tokyo" />
        <option value="Europe/London" />
        <option value="America/Los_Angeles" />
        <option value="America/New_York" />
      </datalist>
      <div className="field-grid two">
        <NumberInput label="宽" min={1} max={2048} value={dashboard.screen.width} onChange={(width) => onChange({ ...dashboard, screen: { ...dashboard.screen, width } })} />
        <NumberInput label="高" min={1} max={2048} value={dashboard.screen.height} onChange={(height) => onChange({ ...dashboard, screen: { ...dashboard.screen, height } })} />
      </div>
      <div className="field-grid two">
        <NumberInput label="列数" min={1} max={12} value={dashboard.grid.columns} onChange={(columns) => onChange({ ...dashboard, grid: { ...dashboard.grid, columns } })} />
        <NumberInput label="行数" min={1} max={16} value={dashboard.grid.rows} onChange={(rows) => onChange({ ...dashboard, grid: { ...dashboard.grid, rows } })} />
      </div>
      <div className="field-grid two">
        <NumberInput label="列间距" min={0} max={80} value={dashboard.grid.columnGap} onChange={(columnGap) => onChange({ ...dashboard, grid: { ...dashboard.grid, columnGap } })} />
        <NumberInput label="行间距" min={0} max={80} value={dashboard.grid.rowGap} onChange={(rowGap) => onChange({ ...dashboard, grid: { ...dashboard.grid, rowGap } })} />
      </div>
      <div className="field-grid two">
        <NumberInput label="上边距" min={0} max={160} value={dashboard.grid.margin.top} onChange={(top) => onChange({ ...dashboard, grid: { ...dashboard.grid, margin: { ...dashboard.grid.margin, top } } })} />
        <NumberInput label="右边距" min={0} max={160} value={dashboard.grid.margin.right} onChange={(right) => onChange({ ...dashboard, grid: { ...dashboard.grid, margin: { ...dashboard.grid.margin, right } } })} />
        <NumberInput label="下边距" min={0} max={160} value={dashboard.grid.margin.bottom} onChange={(bottom) => onChange({ ...dashboard, grid: { ...dashboard.grid, margin: { ...dashboard.grid.margin, bottom } } })} />
        <NumberInput label="左边距" min={0} max={160} value={dashboard.grid.margin.left} onChange={(left) => onChange({ ...dashboard, grid: { ...dashboard.grid, margin: { ...dashboard.grid.margin, left } } })} />
      </div>
      <p className="muted-copy">网格修改会先用共享校验模拟；发生越界、重叠或过小区域时保留原配置。</p>
    </section>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <h3 className="section-title">{title}</h3>;
}

function TextInput({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  return (
    <label>
      {label}
      <input value={value} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  );
}

function NumberInput({
  label,
  min,
  max,
  value,
  onChange
}: {
  label: string;
  min: number;
  max?: number;
  value: number;
  onChange(value: number): void;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(ensureNumber(event.currentTarget.value, value))}
      />
    </label>
  );
}

function ensureNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
