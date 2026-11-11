import { ArrowDown, ArrowUp } from "lucide-react";

type MetricItem = { name: string; value: number | string; unit?: string; split?: string; condition?: string; direction?: "min" | "max" | "none"; note?: string };
const READOUT_LIMIT = 6;

function Direction({ direction, en }: { direction?: string; en: boolean }) {
  if (direction === "min") return <span className="metric-direction" title={en ? "Lower is better" : "越小越好"}><ArrowDown size={12} aria-hidden="true" /><span className="visually-hidden">{en ? "Lower is better" : "越小越好"}</span></span>;
  if (direction === "max") return <span className="metric-direction" title={en ? "Higher is better" : "越大越好"}><ArrowUp size={12} aria-hidden="true" /><span className="visually-hidden">{en ? "Higher is better" : "越大越好"}</span></span>;
  return null;
}

/**
 * A few metrics read as a line of figures with their conditions; many become a table.
 * The condition stays next to the number in both forms: a figure without it is not a result.
 */
export function MetricView({ items, en }: { items: MetricItem[]; en: boolean }) {
  if (!items.length) return <p className="research-hint">{en ? "No metrics recorded." : "尚未填写指标。"}</p>;
  if (items.length <= READOUT_LIMIT) return (
    <dl className="metric-readouts">
      {items.map((item, index) => (
        <div className="metric-readout" key={index}>
          <dt>{item.name}<Direction direction={item.direction} en={en} /></dt>
          <dd>
            <span className="metric-value">{String(item.value)}</span>
            {item.unit && <span className="metric-unit">{item.unit}</span>}
          </dd>
          {(item.split || item.condition) && <dd className="metric-condition">{item.split && <span>{item.split}</span>}{item.condition && <span>{item.condition}</span>}</dd>}
          {item.note && <dd className="metric-note">{item.note}</dd>}
        </div>
      ))}
    </dl>
  );
  const hasCondition = items.some(item => item.split || item.condition), hasNote = items.some(item => item.note);
  return (
    <div className="research-table-wrap">
      <table className="research-table metric-table">
        <thead><tr><th>{en ? "Metric" : "指标"}</th><th className="is-numeric">{en ? "Value" : "数值"}</th><th>{en ? "Unit" : "单位"}</th>{hasCondition && <th>{en ? "Condition" : "条件"}</th>}{hasNote && <th>{en ? "Note" : "备注"}</th>}</tr></thead>
        <tbody>{items.map((item, index) => (
          <tr key={index}>
            <td>{item.name}<Direction direction={item.direction} en={en} /></td>
            <td className="is-numeric">{String(item.value)}</td>
            <td>{item.unit ?? ""}</td>
            {hasCondition && <td className="is-wrapping">{[item.split, item.condition].filter(Boolean).join(en ? ", " : "，")}</td>}
            {hasNote && <td className="is-wrapping">{item.note ?? ""}</td>}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
